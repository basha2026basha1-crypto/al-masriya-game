import { DurableObject } from 'cloudflare:workers';
import {startMatch,startDeal,applyMove,settleSlap,chooseBotMove,privateView} from './engine.js';
/** Authoritative online rooms and card actions. Cards never trust the client. */
const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codeOK=id=>/^[A-HJ-NP-Z2-9]{8}$/.test(id);
const makeCode=()=>{const bytes=crypto.getRandomValues(new Uint8Array(8));return Array.from(bytes,x=>CHARS[x%CHARS.length]).join('');};
const clean=s=>String(s??'').trim().replace(/[<>\u0000-\u001f]/g,'').slice(0,20);
const token=()=>crypto.randomUUID()+'-'+crypto.randomUUID();
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  if(url.pathname==='/api/health')return reply({ok:true,stage:'playable-beta-v0.2'});
  try{
   if(url.pathname==='/api/room/create'&&request.method==='POST'){
    const body=await request.json(),name=clean(body.name),size=Number(body.size);
    if(!name||![2,3,4].includes(size))return reply({error:'اكتب اسمك وحدد عدد اللاعبين 2 أو 3 أو 4.'},400);
    for(let i=0;i<7;i++){
     const code=makeCode(),room=env.ROOMS.getByName(code);
     const result=await room.fetch(new Request('https://internal/create?code='+code,{method:'POST',body:JSON.stringify({name,size})}));
     if(result.status!==409)return result;
    }
    return reply({error:'حاول تنشئ غرفة ثانية.'},503);
   }
   if(url.pathname==='/api/room/join'&&request.method==='POST'){
    const body=await request.json(),code=String(body.code??'').trim().toUpperCase(),name=clean(body.name);
    if(!name||!codeOK(code))return reply({error:'اكتب اسمك وكود الغرفة الصحيح من 8 رموز.'},400);
    return env.ROOMS.getByName(code).fetch(new Request('https://internal/join',{method:'POST',body:JSON.stringify({name})}));
   }
   const match=url.pathname.match(/^\/api\/room\/([A-HJ-NP-Z2-9]{8})\/socket$/);
   if(match&&request.headers.get('upgrade')?.toLowerCase()==='websocket')return env.ROOMS.getByName(match[1]).fetch(request);
   return reply({error:'المسار غير موجود.'},404);
  }catch(e){console.error('API failure',e);return reply({error:'تعذر إكمال الطلب، جرّب مرة ثانية.'},500);}
 }
};
export class GameRoom extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.cached=undefined;}
 async load(){if(this.cached===undefined)this.cached=await this.ctx.storage.get('room')||null;return this.cached;}
 async save(room){this.cached=room;await this.ctx.storage.put('room',room);}
 sockets(){return this.ctx.getWebSockets().filter(w=>w.readyState===1);}
 activeIds(){return new Set(this.sockets().map(w=>w.deserializeAttachment()?.id).filter(Boolean));}
 connected(id){return this.activeIds().has(id);}
 send(ws,data){try{ws.send(JSON.stringify(data));}catch{}}
 publicState(room,selfId){
  const active=this.activeIds(),seat=room.seats.findIndex(p=>p?.id===selfId);
  return {type:'state',code:room.code,size:room.size,phase:room.phase,hostId:room.hostId,partnerId:room.partnerId,settings:room.settings,
   yourself:selfId,ownSeat:seat, members:room.members.map(p=>({id:p.id,name:p.name,online:active.has(p.id),seat:p.seat,returns:p.returns||0})),
   seats:room.seats.map(p=>p?{id:p.id,name:p.name,bot:p.bot,seat:p.seat,online:p.bot||active.has(p.id),ai:p.bot||(!active.has(p.id)&&room.started&&p.botActive)}:null),
   humanCount:room.members.filter(p=>!p.blocked).length,game:room.game?privateView(room.game,seat):null};
 }
 broadcast(room){for(const ws of this.sockets())this.send(ws,this.publicState(room,ws.deserializeAttachment()?.id));}
 pickHost(room){
  const active=this.activeIds();if(active.has(room.hostId))return;
  const present=room.members.filter(p=>active.has(p.id)&&!p.blocked).sort((a,b)=>a.joinOrder-b.joinOrder);
  if(present.length)room.hostId=present[0].id;
 }
 arrangeSeats(room){
  const host=room.members.find(p=>p.id===room.hostId)||room.members[0];
  const others=room.members.filter(p=>p.id!==host.id);const seats=Array(room.size).fill(null);
  const put=(p,i)=>{if(p){p.seat=i;seats[i]={id:p.id,name:p.name,bot:false,seat:i};}};
  put(host,0);
  if(room.size===4){
   const partner=others.find(p=>p.id===room.partnerId),rivals=others.filter(p=>p.id!==partner?.id);
   put(partner,2);put(rivals[0],1);put(rivals[1],3);
  } else others.forEach((p,i)=>put(p,i+1));
  for(let i=0;i<room.size;i++)if(!seats[i])seats[i]={id:`bot_${i}`,name:`كمبيوتر ${i+1}`,bot:true,seat:i};
  return seats;
 }
 isBot(room,seat,now=Date.now()){
  const spot=room.seats[seat];if(!spot)return false;
  if(spot.bot)return true;
  const owner=room.members.find(p=>p.id===spot.id);
  if(!owner||owner.blocked)return true;
  return !this.connected(owner.id)&&owner.disconnectedAt!=null&&now-owner.disconnectedAt>=20000;
 }
 async schedule(room){
  if(room.phase!=='playing'||room.game?.phase!=='playing'){
   if(this.ctx.storage.deleteAlarm)await this.ctx.storage.deleteAlarm();return;
  }
  const g=room.game,now=Date.now();let at=g.clock?.deadline||now+20000;
  if(g.pending){
   if(g.pending.botCheckAt)at=Math.min(at,g.pending.botCheckAt);
  } else {
   const owner=room.seats[g.current];
   if(owner?.bot)at=Math.min(at,now+1400);
   else if(!this.connected(owner?.id)){
    const member=room.members.find(p=>p.id===owner?.id);
    const ready=(member?.disconnectedAt??now)+20000;
    at=Math.min(at,ready<=now?now+1400:ready);
   }
  }
  await this.ctx.storage.setAlarm(Math.max(now+50,at));
 }
 async persistAndBroadcast(room){await this.save(room);this.broadcast(room);await this.schedule(room);}
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/create'&&request.method==='POST'){
   if(await this.load())return reply({error:'الكود مستخدم.'},409);
   const {name,size}=await request.json(),id=crypto.randomUUID(),secret=token(),code=url.searchParams.get('code');
   const room={code,size,phase:'lobby',hostId:id,partnerId:null,settings:{turnSeconds:20},started:false,game:null,
    members:[{id,name,auth:secret,joinOrder:0,seat:null,returns:0,wasConnected:false,disconnectedAt:null,blocked:false}],seats:[],createdAt:Date.now()};
   await this.save(room);return reply({code,playerId:id,token:secret});
  }
  if(url.pathname==='/join'&&request.method==='POST'){
   const room=await this.load();if(!room)return reply({error:'الغرفة غير موجودة.'},404);
   const name=clean((await request.json()).name);if(!name)return reply({error:'الاسم مطلوب.'},400);
   if(room.phase==='lobby'&&room.members.length>=room.size)return reply({error:'الغرفة ممتلئة.'},409);
   const free=room.phase==='lobby'?-1:room.seats.findIndex(p=>p?.bot);
   if(room.phase!=='lobby'&&free<0)return reply({error:'ماكو مقعد كمبيوتر فارغ حالياً.'},409);
   const id=crypto.randomUUID(),secret=token(),joinOrder=Math.max(-1,...room.members.map(p=>p.joinOrder))+1;
   const p={id,name,auth:secret,joinOrder,seat:null,returns:0,wasConnected:false,disconnectedAt:null,blocked:false};
   if(free>=0){
    p.seat=free;room.seats[free]={id,name,bot:false,seat:free};
    // New human takes over the former bot seat immediately; give a full turn if it was the bot's turn.
    if(room.game?.phase==='playing'&&!room.game.pending&&room.game.current===free){
     room.game.clock={kind:'turn',deadline:Date.now()+room.settings.turnSeconds*1000};
    }
   }
   room.members.push(p);
   await this.persistAndBroadcast(room);
   return reply({code:room.code,playerId:id,token:secret});
  }
  if(request.headers.get('upgrade')?.toLowerCase()==='websocket'){
   const room=await this.load();if(!room)return reply({error:'الغرفة غير موجودة.'},404);
   const id=url.searchParams.get('playerId'),key=url.searchParams.get('token');
   const p=room.members.find(p=>p.id===id&&p.auth===key);
   if(!p||p.blocked)return reply({error:'ما مسموح إلك ترجع للمباراة الحالية.'},403);
   const hadConnection=p.wasConnected,wasGone=p.disconnectedAt!==null;
   if(room.started&&hadConnection&&wasGone){
    if(p.returns>=3){p.blocked=true;await this.save(room);return reply({error:'استنفدت فرص الرجوع الثلاث لهالمباراة.'},403);}
    p.returns++;
   }
   // An old socket for this identity must not duplicate actions.
   for(const existing of this.sockets())if(existing.deserializeAttachment()?.id===id){try{existing.close(4000,'replaced connection');}catch{}}
   const [client,server]=Object.values(new WebSocketPair());
   this.ctx.acceptWebSocket(server);server.serializeAttachment({id});
   p.wasConnected=true;p.disconnectedAt=null;p.botActive=false;
   this.pickHost(room);
   await this.save(room);this.broadcast(room);await this.schedule(room);
   return new Response(null,{status:101,webSocket:client});
  }
  return reply({error:'طلب غير معروف.'},404);
 }
 async webSocketMessage(ws,message){
  const room=await this.load();if(!room)return;
  const senderId=ws.deserializeAttachment()?.id,p=room.members.find(p=>p.id===senderId);
  if(!p||p.blocked)return this.send(ws,{type:'error',message:'غير مصرح لك.'});
  let cmd;try{cmd=JSON.parse(String(message));}catch{return;}
  const error=s=>this.send(ws,{type:'error',message:s});
  const host=room.hostId===senderId;
  if(cmd.type==='choose_partner'){
   if(!host||room.phase!=='lobby'||room.size!==4)return error('اختيار الشريك لمدير غرفة الأربعة قبل البدء فقط.');
   if(cmd.partnerId!==null&&!room.members.some(m=>m.id===cmd.partnerId&&m.id!==senderId))return error('اختار لاعب موجود.');
   room.partnerId=cmd.partnerId;
  }else if(cmd.type==='set_turn'){
   if(!host||room.phase!=='lobby')return error('إعدادات الدور لمدير الغرفة قبل البدء.');
   if(![15,20,30,45,60].includes(Number(cmd.seconds)))return error('اختار وقت من القائمة.');
   room.settings.turnSeconds=Number(cmd.seconds);
  }else if(cmd.type==='start'){
   if(!host||room.phase!=='lobby')return error('فقط مدير الغرفة يكدر يبدأ.');
   room.seats=this.arrangeSeats(room);room.game=startMatch(room.size,{turnSeconds:room.settings.turnSeconds});
   room.started=true;room.phase='playing';
  }else if(cmd.type==='move'){
   if(room.phase!=='playing'||!room.game)return error('المباراة ما بَدَت.');
   const seat=room.seats.findIndex(s=>s?.id===senderId);
   if(seat<0||!this.connected(senderId))return error('المقعد مو متاح.');
   const now=Date.now();
   if(room.game.clock&&now>room.game.clock.deadline)return error('خلص الوقت، انتظر الحركة الجاية.');
   const result=applyMove(room.game,seat,cmd.move,now);if(!result.ok)return error(result.error);
   room.phase=room.game.phase;
  }else if(cmd.type==='next_deal'){
   if(room.phase!=='between'||!host)return error('مدير الغرفة يبدأ الجولة التالية.');
   startDeal(room.game,Date.now());room.phase='playing';
  }else if(cmd.type==='restart'){
   if(!host||room.phase!=='finished')return error('إعادة المباراة لمدير الغرفة بعد النهاية.');
   room.members.forEach(m=>{m.returns=0;m.blocked=false;});
   room.game=startMatch(room.size,{turnSeconds:room.settings.turnSeconds});room.phase='playing';
  }else if(cmd.type==='leave'){
   if(room.phase==='lobby'){
    room.members=room.members.filter(m=>m.id!==senderId);
    if(room.partnerId===senderId)room.partnerId=null;
   }
   p.disconnectedAt=Date.now();try{ws.close(1000,'left');}catch{}
   this.pickHost(room);
  }else return;
  await this.persistAndBroadcast(room);
 }
 async webSocketClose(ws){
  const room=await this.load();if(!room)return;
  const id=ws.deserializeAttachment()?.id;
  const p=room.members.find(m=>m.id===id);
  if(p&&!this.connected(id)){p.disconnectedAt=Date.now();p.botActive=false;}
  this.pickHost(room);
  await this.persistAndBroadcast(room);
 }
 async webSocketError(ws){try{ws.close(1011,'connection error');}catch{}}
 async alarm(){
  const room=await this.load();if(!room||room.phase!=='playing'||!room.game||room.game.phase!=='playing')return;
  const game=room.game,now=Date.now();let changed=false;
  if(game.pending){
   if(game.pending.botCheckAt&&now>=game.pending.botCheckAt){
    // Each bot may intervene at most once per slap chain. No hidden human cards exposed to bots.
    let acted=false;
    for(let i=0;i<room.size;i++){
     if(!this.isBot(room,i,now))continue;
     const move=chooseBotMove(game,i);
     if(move&&move.type==='slap'){
      const res=applyMove(game,i,move,now);
      if(res.ok){acted=true;changed=true;break;}
     }
    }
    if(!acted)game.pending.botCheckAt=null;
   }
   if(game.pending&&now>=game.pending.deadline){settleSlap(game,now);changed=true;}
  } else if(now>=game.clock.deadline||this.isBot(room,game.current,now)){
   // One AI move per alarm to keep Durable Object work bounded.
   const move=chooseBotMove(game,game.current);
   if(move){const res=applyMove(game,game.current,move,now);changed=res.ok;}
   else {
    // Failsafe: a player who is down to their protected final card is skipped.
    if(game.stock.length===0){
     const next=(game.current+1)%game.size;
     game.current=next;game.clock.deadline=now+game.turnSeconds*1000;
     changed=true;
    }
   }
  }
  room.phase=game.phase;
  if(changed)await this.save(room);
  if(changed)this.broadcast(room);
  await this.schedule(room);
 }
}
