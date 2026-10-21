// Authorized one-day campaign. Automatically inert after the Taipei event date.
export const FUNBOX_EVENT_DATE = '2026-10-21';
export const FUNBOX_EVENT_PRODUCTS = [
  {id:'bbpr07733',name:'【APP兌換】BEYBLADE X 戰鬥陀螺 CX-00 海怪扭擺'},
  {id:'bbpr07736',name:'【APP兌換】BEYBLADE X 戰鬥陀螺 CX-00 雄鹿戰角'},
  {id:'bbpr07730',name:'【APP兌換】BEYBLADE X 戰鬥陀螺 CX-00 黃蜂要塞'},
  {id:'bbpr07739',name:'【APP兌換】購買票券_戰鬥陀螺 CX-00 龍神勇氣'}
].map(p=>({...p,url:'https://shop.funbox.com.tw/products/'+p.id}));
export const isFunboxEventDay = now => new Date(Number(now)+8*3600000).toISOString().slice(0,10)===FUNBOX_EVENT_DATE;
export function funboxEventDelay(now,{failed=false,retryAfterMs=0,normalMs=2000}={}) {
  return Math.max(retryAfterMs, isFunboxEventDay(now) ? failed ? 2000 : 1000 : normalMs);
}
export class FunboxEventDay {
  constructor({state,notify,log=()=>{},now=Date.now,enabled=()=>true}){Object.assign(this,{state,notify,log,now,enabled});this.pending=new Set();}
  data(){this.state.data.commerce ||= {};return this.state.data.commerce.funboxEventDay20261021 ||= {notifications:{}};}
  status(){return{date:FUNBOX_EVENT_DATE,active:isFunboxEventDay(this.now()),reminders:['09:30','09:50'],notifications:this.data().notifications};}
  async once(key,title,products){
    const marks=this.data().notifications;if(marks[key]||this.pending.has(key))return;
    this.pending.add(key);
    try{
      marks[key]={status:'sending',at:new Date(this.now()).toISOString()};await this.state.writeSnapshot();
      const lines=products.map(p=>`[${p.name}](${p.url})`);
      try{
        const id=await this.notify(title+'\n'+products.map(p=>p.name+'\n'+p.url).join('\n'),{channelMode:'discord',discordAudience:'public',embeds:[{title,color:0xe5484d,description:['今天 10:00 開放 APP 序號兌換；請備妥對應序號。',...lines].join('\n\n'),timestamp:new Date(this.now()).toISOString()}]});
        marks[key]={...marks[key],status:'sent',messageId:id||null};this.log('FUNBOX 活動 DC 已發送：'+key,'funbox');
      }catch{marks[key]={...marks[key],status:'unknown'};this.log('FUNBOX 活動 DC 回應不明，保留一次發送紀錄、不重複推播：'+key,'funbox');}
      await this.state.writeSnapshot();
    }finally{this.pending.delete(key);}
  }
  async tick(){
    if(!this.enabled()||!isFunboxEventDay(this.now()))return;
    for(const time of ['09:30','09:50']){const due=Date.parse(FUNBOX_EVENT_DATE+'T'+time+':00+08:00');if(this.now()>=due&&this.now()<due+60000)await this.once('reminder-'+time,'⏰ FUNBOX APP 兌換提醒｜'+time,FUNBOX_EVENT_PRODUCTS);}
  }
  async observe(product){
    if(!this.enabled()||!isFunboxEventDay(this.now())||this.now()<Date.parse(FUNBOX_EVENT_DATE+'T10:00:00+08:00'))return;
    const target=FUNBOX_EVENT_PRODUCTS.find(p=>p.id===String(product.id));
    if(target&&/APP/i.test(product.title||''))await this.once('listed-'+target.id,'🛒 APP 兌換已上架｜'+target.name,[target]);
  }
  start(){if(this.timer||!isFunboxEventDay(this.now()))return;void this.tick().catch(()=>this.log('FUNBOX 活動提醒狀態儲存失敗','funbox'));this.timer=setInterval(()=>{void this.tick().catch(()=>this.log('FUNBOX 活動提醒狀態儲存失敗','funbox'));},1000);this.timer.unref?.();}
  close(){clearInterval(this.timer);}
}
