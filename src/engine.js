/** المصرية — pure, authoritative rules engine. No browser/server dependencies. */
export const CARD_SUITS=['♠','♥','♦','♣'];
export const RANKS=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
export const pointValue=c=>!c?0:c.rank==='JOKER'?50:['10','J','Q','K'].includes(c.rank)?10:0;
export const cardText=c=>!c?'':c.rank==='JOKER'?'🃏':`${c.rank}${c.suit}`;
export function makeDeck(random=Math.random){
 const cards=[];
 for(let d=0;d<2;d++)for(const suit of CARD_SUITS)for(const rank of RANKS)cards.push({id:`${d}-${suit}-${rank}`,rank,suit});
 for(let i=0;i<2;i++)cards.push({id:`joker-${i}`,rank:'JOKER',suit:''});
 for(let i=cards.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[cards[j],cards[i]]=[cards[i],cards[j]];}
 return cards;
}
const err=message=>({ok:false,error:message});
const ok=()=>({ok:true});
const nextSeat=(game,seat)=>(seat+1)%game.size; // seats are numbered counter-clockwise.
const topRun=pile=>{
 if(!pile?.length)return [];
 const rank=pile[pile.length-1].rank;const result=[];
 for(let i=pile.length-1;i>=0&&pile[i].rank===rank;i--)result.push(pile[i]);
 return result;
};
const drawOne=(game,seat)=>{if(game.stock.length)game.hands[seat].push(game.stock.pop());};
// Rule: when a player's hand reaches ZERO during a deal, refill up to FOUR
// cards immediately from stock. A normal capture still draws just ONE card
// if the hand did not become empty. After stock exhaustion, the last card is protected.
function refillEmptyHand(game,seat){
 if(game.hands[seat].length!==0||!game.stock.length)return 0;
 let count=0;
 while(count<4&&game.stock.length){drawOne(game,seat);count++;}
 return count;
}
// Keep the captured rank visible on top of the winner's pile, never a Joker.
// If a Joker was used to take Jacks, e.g., the pile is [..., Joker, Jack, Jack],
// so the next player can slap using a Jack. This works for ANY rank.
function wonCardOrder(cards,rank){
 const jokers=cards.filter(c=>c.rank==='JOKER');
 const captured=cards.filter(c=>c.rank!=='JOKER');
 return [...jokers,...captured];
}
const noCardsLeftInHand=game=>game.stock.length===0&&game.hands.every(h=>h.length===1);
function revealIfEmpty(game,seat){
 if(game.table.length||!game.stock.length)return false;
 let joker=false;
 for(let i=0;i<4&&game.stock.length;i++){
  const card=game.stock.pop();
  if(card.rank==='JOKER'){game.hands[seat].push(card);joker=true;}
  else game.table.push(card);
 }
 return joker;
}
function beginTurn(game,seat,now,draw=true){
 game.current=seat;
 // A player with only the protected final card is skipped after the stock runs out.
 if(!game.stock.length&&!noCardsLeftInHand(game)){
  for(let j=0;j<game.size&&game.hands[game.current].length<=1;j++)game.current=nextSeat(game,game.current);
 }
 seat=game.current;
 // Replenishing the ground happens before drawing for this turn.
 const grantedJoker=revealIfEmpty(game,seat);
 if(draw&&!grantedJoker)drawOne(game,seat);
 // The draw above can exhaust the stock and leave this player with only
 // the protected last card. Transfer to the next seat with a legal play.
 if(!game.stock.length && game.hands[seat].length<=1 && !noCardsLeftInHand(game)){
  for(let j=0;j<game.size;j++){
   const candidate=nextSeat(game,seat);
   seat=candidate;
   if(game.hands[seat].length>1)break;
  }
  game.current=seat;
 }
 game.lastTurn=seat;game.lastVisit[seat]=++game.visitCounter;
 game.clock={kind:'turn',deadline:now+game.turnSeconds*1000};
 finishIfNeeded(game,now);
}
export function startMatch(size,{now=Date.now(),random=Math.random,turnSeconds=20}={}){
 if(![2,3,4].includes(size))throw Error('Invalid player count');
 const game={size,scores:Array(size===4?2:size).fill(0),phase:'playing',deal:0,starter:Math.floor(random()*size),
  turnSeconds:Math.min(120,Math.max(10,Number(turnSeconds)||20)),history:[],visitCounter:0,lastVisit:Array(size).fill(0),lastTurn:0,
  winner:null, pending:null,revision:0,notice:''};
 startDeal(game,now,random);return game;
}
export function startDeal(game,now=Date.now(),random=Math.random){
 game.deal++;game.phase='playing';game.winner=null;game.pending=null;game.replay=false;
 game.hands=Array.from({length:game.size},()=>[]);
 game.piles=Array.from({length:game.size},()=>[]);game.table=[];
 let deck=null;
 for(let attempt=0;attempt<2000;attempt++){
  deck=makeDeck(random);const first=deck.splice(-4);
  const counts={};for(const c of first)counts[c.rank]=(counts[c.rank]||0)+1;
  if(!first.some(c=>c.rank==='JOKER') && Math.max(...Object.values(counts))<3){game.table=first;break;}
 }
 if(game.table.length!==4)throw Error('Could not arrange the first four cards');
 game.stock=deck;
 for(let i=0;i<game.size;i++){
  const seat=(game.starter+i)%game.size, count=i===0?5:4;
  for(let j=0;j<count;j++)drawOne(game,seat);
 }
 game.lastVisit=Array(game.size).fill(0);
 game.visitCounter=0;
 beginTurn(game,game.starter,now,false);
 game.notice=`الجولة ${game.deal} — الراس كرت هو اللاعب ${game.starter+1}`;
 game.revision++;
 return game;
}
function roundScores(game){
 const individuals=game.piles.map((pile,i)=>pile.reduce((s,c)=>s+pointValue(c),0)+game.hands[i].reduce((s,c)=>s+pointValue(c),0));
 const groupScores=game.size===4?[individuals[0]+individuals[2],individuals[1]+individuals[3]]:individuals;
 return {individuals,groups:groupScores};
}
export function settleScoring(game){
 const {individuals,groups}=roundScores(game);
 const highest=Math.max(...groups),leaders=groups.map((v,i)=>v===highest?i:-1).filter(i=>i>=0);
 const replay=leaders.length===groups.length;
 const awards=Array(groups.length).fill(0);
 if(!replay)for(const i of leaders)awards[i]=groups[i];
 awards.forEach((v,i)=>game.scores[i]+=v);
 let starter;
 if(replay)starter=game.lastTurn;
 else if(game.size===4){
  const pair=leaders[0]===0?[0,2]:[1,3];
  starter=pair[0];
  if(individuals[pair[1]]>individuals[pair[0]])starter=pair[1];
  else if(individuals[pair[1]]===individuals[pair[0]]&&game.lastVisit[pair[1]]>game.lastVisit[pair[0]])starter=pair[1];
 } else if(leaders.length===1)starter=leaders[0];
 else starter=leaders.slice().sort((a,b)=>game.lastVisit[b]-game.lastVisit[a])[0];
 const matchWinners=game.scores.map((v,i)=>v>=1000?i:-1).filter(v=>v>=0);
 const result={deal:game.deal,individuals,groups,awards,leaders,replay,nextStarter:starter};
 game.history.push(result);game.lastResult=result;game.starter=starter;
 game.phase=matchWinners.length?'finished':'between';game.winner=matchWinners;
 game.clock=null;game.notice=replay?'تعادل — الجولة تنعاد وماكو نقاط.':`انتهت الجولة ${game.deal} — اضغط «الجولة التالية»`;
 game.revision++;
}
function finishIfNeeded(game){if(game.phase==='playing'&&!game.pending&&noCardsLeftInHand(game))settleScoring(game);}
export function possibleCaptures(game,seat){
 if(game.phase!=='playing'||game.pending||game.current!==seat)return [];
 if(game.stock.length===0&&game.hands[seat].length<=1)return [];
 const options=[];
 for(const card of game.hands[seat]){
  for(const target of game.table){
   if(card.rank===target.rank||card.rank==='JOKER') options.push({type:'capture',cardId:card.id,source:'table',targetId:target.id,rank:target.rank,cards:1,value:pointValue(target)});
  }
  for(let i=0;i<game.size;i++){
   if(!game.piles[i].length||i===seat)continue;
   const run=topRun(game.piles[i]);
   if(card.rank===run[0].rank||card.rank==='JOKER')options.push({type:'capture',cardId:card.id,source:'pile',targetSeat:i,rank:run[0].rank,cards:run.length,value:run.reduce((s,c)=>s+pointValue(c),0)});
  }
 }
 return options;
}
export function applyMove(game,seat,move,now=Date.now()){
 if(game.phase!=='playing')return err('الجولة مو بحالة لعب حالياً.');
 if(!Number.isInteger(seat)||seat<0||seat>=game.size)return err('المقعد غير صحيح.');
 if(game.pending)return slap(game,seat,move,now);
 if(seat!==game.current)return err('مو دورك حالياً.');
 if(!move||!['capture','discard'].includes(move.type))return err('اختار حركة صحيحة.');
 const hand=game.hands[seat],index=hand.findIndex(c=>c.id===move.cardId);
 if(index<0)return err('هاي الورقة مو بإيدك.');
 if(game.stock.length===0&&hand.length<=1)return err('ممنوع تلعب آخر ورقة بعد نفاد السحب.');
 if(move.type==='discard'){
  const card=hand.splice(index,1)[0];game.table.push(card);
  const refilled=refillEmptyHand(game,seat);
  game.notice=`اللاعب ${seat+1} لكح ${cardText(card)} بالكاع${refilled?' — تجددت إيده '+refilled+' ورقات':''}`;
  if(noCardsLeftInHand(game)){game.lastTurn=seat;game.lastVisit[seat]=++game.visitCounter;settleScoring(game);}
  else beginTurn(game,nextSeat(game,seat),now,true);
  game.revision++;return ok();
 }
 const options=possibleCaptures(game,seat);
 const choice=options.find(x=>x.cardId===move.cardId && x.source===move.source && (x.source==='table'?x.targetId===move.targetId:x.targetSeat===Number(move.targetSeat)));
 if(!choice)return err('الطگة غير مسموحة، اختار ورقة مطابقة أو جوكر.');
 const card=hand.splice(index,1)[0];
 const refilled=refillEmptyHand(game,seat);
 let originals=[];
 if(choice.source==='table'){
  const j=game.table.findIndex(c=>c.id===choice.targetId);originals.push(game.table.splice(j,1)[0]);
 } else {
  const pile=game.piles[choice.targetSeat];originals=pile.splice(pile.length-choice.cards,choice.cards);
 }
 game.pending={cards:[...originals,card],rank:choice.rank,lastSeat:seat,touched:[seat],refilledSeats:refilled?[seat]:[],deadline:now+10000,botCheckAt:now+950};
 game.clock={kind:'slap',deadline:game.pending.deadline};
 game.notice=`اللاعب ${seat+1} طگ على ${choice.rank} — 10 ثواني للطگة التالية`;
 game.revision++;return ok();
}
function slap(game,seat,move,now){
 const p=game.pending;
 if(!move||move.type!=='slap')return err('أثناء المنافسة تكدر تطگ فقط.');
 if(now>p.deadline)return err('انتهت مهلة الطگ.');
 if(p.lastSeat===seat)return err('إنت آخر واحد طگ؛ تنتظر طگة من لاعب ثاني حتى ترجع تطگ.');
 const hand=game.hands[seat],idx=hand.findIndex(c=>c.id===move.cardId);
 if(idx<0)return err('هاي الورقة مو بإيدك.');
 const card=hand[idx];
 if(card.rank!==p.rank && card.rank!=='JOKER')return err('لازم تطگ بورقة مطابقة أو جوكر.');
 if(game.stock.length===0&&hand.length<=1)return err('آخر ورقة ما تنلعب حتى بالطگ.');
 hand.splice(idx,1);
 const refilled=refillEmptyHand(game,seat);
 p.cards.push(card);p.lastSeat=seat;p.touched.push(seat);
 if(refilled)(p.refilledSeats||=[]).push(seat);
 p.deadline=now+10000;p.botCheckAt=now+950;
 game.clock={kind:'slap',deadline:p.deadline};
 game.notice=`اللاعب ${seat+1} طگ — تجددت مهلة 10 ثواني`;
 game.revision++;return ok();
}
export function settleSlap(game,now=Date.now()){
 if(!game.pending)return false;
 const p=game.pending;game.piles[p.lastSeat].push(...wonCardOrder(p.cards,p.rank));game.pending=null;
 game.notice=`اللاعب ${p.lastSeat+1} فاز بالطگة (${p.cards.length} ورقات)`;
 if(noCardsLeftInHand(game)){game.lastTurn=p.lastSeat;game.lastVisit[p.lastSeat]=++game.visitCounter;settleScoring(game);}
 else beginTurn(game,p.lastSeat,now,!(p.refilledSeats||[]).includes(p.lastSeat));
 game.revision++;return true;
}
export function teamOf(game,seat){return game.size===4?seat%2:seat;}
export function chooseBotMove(game,seat){
 if(game.phase!=='playing')return null;
 const hand=game.hands[seat];if(game.stock.length===0&&hand.length<=1)return null;
 if(game.pending){
  const p=game.pending;
  if(p.lastSeat===seat||teamOf(game,p.lastSeat)===teamOf(game,seat))return null;
  const matches=hand.filter(c=>c.rank===p.rank||c.rank==='JOKER');
  matches.sort((a,b)=>(a.rank==='JOKER')-(b.rank==='JOKER'));
  const card=matches.find(c=>c.rank!=='JOKER')||matches.find(c=>p.cards.some(x=>pointValue(x)>=10));
  return card?{type:'slap',cardId:card.id}:null;
 }
 if(game.current!==seat)return null;
 const moves=possibleCaptures(game,seat);
 if(moves.length){
  const scored=moves.map(m=>{
   const played=hand.find(x=>x.id===m.cardId);const ownTeam=game.size===4&&teamOf(game,m.targetSeat)===teamOf(game,seat);
   const jokerPenalty=played.rank==='JOKER'?40:0;
   return {m,score:m.value*1.8+m.cards*3-(ownTeam?m.value*1.2+6:0)-jokerPenalty+(m.source==='pile'?4:0)};
  }).sort((a,b)=>b.score-a.score);
  if(scored[0].score>0 || game.stock.length===0)return scored[0].m;
 }
 const discards=hand.filter(c=>!(game.stock.length===0&&hand.length<=1));
 discards.sort((a,b)=>pointValue(a)-pointValue(b) || (a.rank==='JOKER')-(b.rank==='JOKER'));
 return discards.length?{type:'discard',cardId:discards[0].id}:null;
}
export function endTurnByTimeout(game,seat,now=Date.now()){
 const move=chooseBotMove(game,seat);return move?applyMove(game,seat,move,now):err('ماكو حركة متاحة.');
}
export function privateView(game,seat){
 if(!game)return null;
 return {size:game.size,deal:game.deal,phase:game.phase,starter:game.starter,current:game.current,
  stockCount:game.stock.length,hand:seat>=0?game.hands[seat]:[],handCounts:game.hands.map(h=>h.length),
  piles:game.piles.map(p=>({count:p.length,top:p[p.length-1]||null,run:topRun(p).length})),
  table:game.table,pending:game.pending?{cards:wonCardOrder(game.pending.cards,game.pending.rank),rank:game.pending.rank,lastSeat:game.pending.lastSeat,touched:game.pending.touched,deadline:game.pending.deadline}:null,
  scores:game.scores,notice:game.notice,clock:game.clock,revision:game.revision,lastResult:game.lastResult||null,historyLength:game.history.length,winner:game.winner};
}
