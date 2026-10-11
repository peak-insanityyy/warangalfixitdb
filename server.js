// FixWarangal API. Run: OFFICER_KEY=... SUPERVISOR_KEY=... MONGODB_URI=... node server.js
const express=require('express'),helmet=require('helmet'),rl=require('express-rate-limit'),crypto=require('crypto');
const {MongoClient,ObjectId}=require('mongodb'),E=process.env;
const URI=E.MONGODB_URI||'mongodb://127.0.0.1:27017/fixwarangal',OFF=E.OFFICER_KEY,SUP=E.SUPERVISOR_KEY;
if(!OFF||!SUP){console.error('Set OFFICER_KEY and SUPERVISOR_KEY');process.exit(1)}
const DUP_MIN=+E.DUP_WINDOW_MIN||50,DUP_M=+E.DUP_RADIUS_M||100,SCALE=+E.SLA_SCALE||1,CONFIRM_H=+E.CONFIRM_HOURS||72;
// slaH = hours allowed before auto-escalation to the supervisor; w = severity weight for ranking
const CATS={"Potholes & roads":{team:"Roads team",slaH:120,w:2,k:["pothole","road","crack","speed breaker","footpath","bridge"]},
"Drainage":{team:"Sanitation team",slaH:72,w:3,k:["drain","sewage","sewer","manhole","overflow","clog","stagnant","gutter","flood"]},
"Water supply":{team:"Water supply team",slaH:48,w:3,k:["water","tap","pipeline","leak","pressure","tanker","contaminated"]},
"Streetlights":{team:"Electrical team",slaH:96,w:2,k:["light","lamp","dark","pole","wire","electric"]},
"Garbage & sanitation":{team:"Sanitation team",slaH:24,w:2,k:["garbage","trash","waste","dump","bin","smell","litter","mosquito"]},
"Other":{team:"General administration",slaH:168,w:1,k:[]}};
const AREAS={Hanamkonda:[18.0049,79.558],Kazipet:[17.9784,79.53],Subedari:[18.0069,79.57],Naimnagar:[17.992,79.56],"Hunter Road":[17.999,79.579],"Kakaji Colony":[18.001,79.575],Waddepally:[17.989,79.543],"Warangal Fort":[17.95,79.6]};
const BB=[17.85,18.1,79.45,79.7]; // lat/lng box: GPS outside Warangal is ignored
const classify=t=>{t=t.toLowerCase();let b="Other",h=0;for(const k in CATS){const n=CATS[k].k.filter(w=>t.includes(w)).length;if(n>h){h=n;b=k}}return b};
const clean=(s,n)=>typeof s==='string'?s.replace(/[\u0000-\u001f<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,n):'';
const jpegs=(a,min,max)=>{a=a||[];if(!Array.isArray(a)||a.length<min||a.length>max)return null;
 for(const p of a)if(typeof p!=='string'||p.length>6e5||!p.startsWith('data:image/jpeg;base64,/9j/')||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(p))return null;return a};
const h=x=>crypto.createHash('sha256').update(x||'').digest(),eq=(a,b)=>crypto.timingSafeEqual(h(a),h(b));
const role=q=>{const k=q.get('x-key');return eq(k,SUP)?'supervisor':eq(k,OFF)?'officer':'none'};
const staff=(q,s,n)=>role(q)==='none'?s.status(401).json({error:'Officer key required'}):n();
const lim=(n,ms)=>rl({windowMs:ms,limit:n,standardHeaders:true,legacyHeaders:false,message:{error:'Too many requests. Please try again later.'}});
const w=f=>(q,s)=>f(q,s).catch(e=>{console.error(e);s.status(500).json({error:'Server error'})});
const bad=(s,m,c=400)=>s.status(c).json({error:m}),oid=x=>ObjectId.isValid(x)?new ObjectId(x):null;

(async()=>{
const db=(await MongoClient.connect(URI)).db(),I=db.collection('issues'),V=db.collection('votes');
await I.createIndex({loc:'2dsphere'});await I.createIndex({pr:-1,createdAt:1});
await I.createIndex({s:1,slaDue:1});await I.createIndex({c:1,createdAt:-1});
await V.createIndex({issue:1,voter:1},{unique:true}); // one "I see this too" per person per issue

const app=express();app.set('trust proxy',+E.TRUST_PROXY||0);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],fontSrc:["https://fonts.gstatic.com"],imgSrc:["'self'","data:"],connectSrc:["'self'"]}}}));
app.use(express.json({limit:'2.5mb'}));
app.use('/api',lim(300,9e5),(q,s,n)=>{ // anonymous device id + JSON-only writes (blocks cross-site form posts)
 let m=/(?:^|; )fw=([a-f0-9]{32})/.exec(q.headers.cookie||'');q.voter=m?m[1]:crypto.randomBytes(16).toString('hex');
 if(!m)s.append('Set-Cookie',`fw=${q.voter}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${q.secure?'; Secure':''}`);
 if(q.method==='POST'&&!q.is('application/json'))return bad(s,'JSON required',415);n()});
app.use(express.static(__dirname+'/public'));

const pub=(i,v)=>({id:String(i._id),t:i.t,d:i.d,a:i.a,c:i.c,s:i.s,date:i.createdAt,up:i.up,img:i.nb,aft:i.na,esc:i.esc,due:i.slaDue,fix:i.confirmBy,cl:i.closedAt,re:i.re,ok:i.ok,no:i.no,ev:i.ev.slice(-15),voted:!!v,verdict:v&&v.verdict||null,canVerify:i.s===3&&!!v});
const ev=(type,text)=>({at:new Date(),type,text});
async function vote(id,voter,kind){try{await V.insertOne({issue:id,voter,kind,at:new Date()})}catch(e){if(e.code===11000)return false;throw e}
 await I.updateOne({_id:id},{$inc:{up:1,pr:10}});return true}

app.get('/api/me',lim(20,9e5),(q,s)=>s.json({role:role(q)}));
app.get('/api/issues',w(async(q,s)=>{
 const L=await I.find({},{projection:{photos:0,afters:0}}).sort({pr:-1,createdAt:1}).limit(300).toArray(); // pr = upvotes*10 + severity + escalation bonus
 const my=new Map((await V.find({voter:q.voter,issue:{$in:L.map(i=>i._id)}}).toArray()).map(v=>[String(v.issue),v]));
 s.json(L.map(i=>pub(i,my.get(String(i._id)))))}));
app.get('/api/photo/:id/:k/:n',w(async(q,s)=>{const id=oid(q.params.id);if(!id)return bad(s,'Not found',404);
 const i=await I.findOne({_id:id},{projection:{photos:1,afters:1}}),d=i&&(q.params.k==='a'?i.afters:i.photos)[+q.params.n];
 if(!d)return bad(s,'Not found',404);s.set('Cache-Control','public,max-age=86400').type('jpeg').send(Buffer.from(d.split(',')[1],'base64'))}));

app.post('/api/issues',lim(6,36e5),w(async(q,s)=>{const b=q.body||{};
 if(b.hp)return bad(s,'Rejected');                       // honeypot
 if(!(b.el>=3000))return bad(s,'Please describe the problem before posting.'); // too-fast bots
 const t=clean(b.text,500);if(t.length<8)return bad(s,'Add a few more words so we can sort your problem.');
 const ar=AREAS[b.area];if(!ar)return bad(s,'Unknown area');
 const ph=jpegs(b.photos,0,3);if(!ph)return bad(s,'Photos must be JPEG, up to 3.');
 let lat=+b.lat,lng=+b.lng;const precise=lat>=BB[0]&&lat<=BB[1]&&lng>=BB[2]&&lng<=BB[3];if(!precise)[lat,lng]=ar;
 const c=classify(t),loc={type:'Point',coordinates:[lng,lat]};
 if(precise){ // same category + open + last 50 min + within 100 m (2dsphere $near) => "I see this too"
  const d=await I.findOne({c,precise:true,s:{$lt:4},createdAt:{$gte:new Date(Date.now()-DUP_MIN*6e4)},loc:{$near:{$geometry:loc,$maxDistance:DUP_M}}});
  if(d){const added=await vote(d._id,q.voter,'upvote');const f=await I.findOne({_id:d._id},{projection:{photos:0,afters:0}});
   return s.json({dup:true,added,issue:pub(f,{})})}}
 const now=new Date(),C=CATS[c],doc={t:t.length>52?t.slice(0,50)+'…':t,d:t,a:b.area,c,s:0,loc,precise,createdAt:now,up:0,pr:C.w*5,photos:ph,nb:ph.length,afters:[],na:0,
  slaDue:new Date(+now+C.slaH*36e5*SCALE),esc:false,re:0,ok:0,no:0,ev:[ev('reported','Reported by a citizen'),ev('routed','Routed to '+C.team)]};
 const r=await I.insertOne(doc);await vote(r.insertedId,q.voter,'report');
 s.json({dup:false,issue:pub({...doc,_id:r.insertedId,up:1,photos:undefined},{})})}));

app.post('/api/issues/:id/upvote',lim(60,36e5),w(async(q,s)=>{const id=oid(q.params.id);
 const i=id&&await I.findOne({_id:id,s:{$lt:4}});if(!i)return bad(s,'Not found',404);
 s.json({added:await vote(id,q.voter,'upvote')})}));

app.post('/api/issues/:id/status',lim(60,9e5),staff,w(async(q,s)=>{const id=oid(q.params.id),n=+q.body.s;
 if(!id||![1,2].includes(n))return bad(s,'Bad request');
 const r=await I.updateOne({_id:id,s:{$lt:n}},{$set:{s:n},$push:{ev:ev('status',n===1?'Assigned to team':'Work started')}});
 r.matchedCount?s.json({ok:true}):bad(s,'Cannot move to that status',409)}));

// An after photo is mandatory. Fixed != Resolved: citizens must confirm.
app.post('/api/issues/:id/resolve',lim(60,9e5),staff,w(async(q,s)=>{const id=oid(q.params.id),a=jpegs(q.body.after,1,1);
 if(!id)return bad(s,'Bad request');if(!a)return bad(s,'An after photo (JPEG) is required to mark an issue fixed.');
 const now=new Date(),note=clean(q.body.note,300);
 const r=await I.updateOne({_id:id,s:{$in:[0,1,2]}},{$set:{s:3,ok:0,no:0,confirmBy:new Date(+now+CONFIRM_H*36e5)},$push:{afters:a[0],ev:ev('fixed','Marked fixed with after photo'+(note?': '+note:'')+'. Waiting for citizens to confirm.')},$inc:{na:1}});
 if(!r.matchedCount)return bad(s,'Issue is not open',409);
 await V.updateMany({issue:id},{$unset:{verdict:1}});s.json({ok:true})}));

// Only people who reported or backed the issue can confirm or reopen.
async function settle(id,final){const i=await I.findOne({_id:id,s:3});if(!i)return;
 const half=Math.ceil(await V.countDocuments({issue:id})/2),now=new Date();
 if(i.no>i.ok&&i.no>=half){const C=CATS[i.c];
  await I.updateOne({_id:id},{$set:{s:2,esc:true,slaDue:new Date(+now+C.slaH*18e5*SCALE)},$inc:{re:1,pr:50},$push:{ev:ev('reopened','Reopened by citizens. Escalated to Supervisor.')}})}
 else if(i.ok>=half||final)await I.updateOne({_id:id},{$set:{s:4,closedAt:now,pr:0},$push:{ev:ev('closed','Confirmed fixed. Issue closed.')}})}
app.post('/api/issues/:id/verify',lim(60,36e5),w(async(q,s)=>{const id=oid(q.params.id);
 if(!id||typeof q.body.ok!=='boolean')return bad(s,'Bad request');
 if(!await I.findOne({_id:id,s:3}))return bad(s,'This issue is not awaiting confirmation.',409);
 const r=await V.updateOne({issue:id,voter:q.voter},{$set:{verdict:q.body.ok?'ok':'no'}});
 if(!r.matchedCount)return bad(s,'Only people who reported or backed this issue can confirm it.',403);
 await I.updateOne({_id:id},{$set:{ok:await V.countDocuments({issue:id,verdict:'ok'}),no:await V.countDocuments({issue:id,verdict:'no'})}});
 await settle(id,false);s.json({ok:true})}));

// SLA watchdog: breached + not fixed => escalate once; confirmation window over => settle.
setInterval(async()=>{try{const now=new Date();
 for(const i of await I.find({s:{$lt:3},esc:false,slaDue:{$lt:now}},{projection:{photos:0,afters:0}}).toArray()){
  const r=await I.updateOne({_id:i._id,esc:false},{$set:{esc:true,escAt:now},$inc:{pr:50},$push:{ev:ev('escalated','SLA breached. Auto-escalated to Supervisor.')}});
  if(r.modifiedCount&&E.SUPERVISOR_WEBHOOK)fetch(E.SUPERVISOR_WEBHOOK,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:`SLA breached: ${i.c} in ${i.a} (#${i._id})`})}).catch(()=>{})}
 for(const i of await I.find({s:3,confirmBy:{$lt:now}},{projection:{_id:1}}).toArray())await settle(i._id,true)}catch(e){console.error(e)}},6e4);

app.listen(+E.PORT||3000,()=>console.log('FixWarangal on :'+(E.PORT||3000)));
})();
