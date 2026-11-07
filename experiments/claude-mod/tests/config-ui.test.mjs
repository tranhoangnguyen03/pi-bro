import {test} from "node:test";
import assert from "node:assert/strict";
import {register} from "../hooks/register.js";

function setup() {
  const hooks=[];
  register((event,matcher,cb)=>hooks.push({event,matcher:typeof matcher==="function"?null:matcher,fn:typeof matcher==="function"?matcher:cb}));
  const values=new Map();
  let panel, lastCall;
  const $={
    store:{get:async key=>values.get(key),set:async(key,v)=>{values.set(key,v);}},
    plugin:{root:"/test/plugin"},
    command:{register:async()=>{}},
    session:{model:async()=> "sonnet",messages:async()=>[{role:"assistant",text:"source reply",toolUses:[]}]},
    model:{complete:async()=> "native result"},
    process:{run:async(argv,opts)=>{
      lastCall={argv,request:JSON.parse(opts.stdin)};
      return {exitCode:0,stdout:JSON.stringify({ok:true,result:{text:"codex result"}}),stderr:""};
    }},
    ui:{
      open:async x=>{panel=x.id;},close:async()=>{},invalidate:()=>{},toast:()=>{},
      resolve:()=>{
        const mk=type=>p=>({type,...p});
        return {Box:mk("Box"),Text:mk("Text"),Button:mk("Button"),Input:mk("Input"),Select:mk("Select"),Markdown:mk("Markdown")};
      }
    }
  };
  const fire=(name,e,match)=>{
    const h=hooks.find(x=>x.event===name && (!match || x.matcher?.command===match || x.matcher?.component===match));
    if(!h)throw Error("Missing "+name);
    return h.fn($,e,async()=>({}));
  };
  const render=(id)=>fire("ui.render",{component:"Pane",requestId:id,surface:"terminal"},"Pane");
  const find=(obj,key)=>{
    if(!obj||typeof obj!=="object")return null;
    if(obj.key===key)return obj;
    for(const v of [].concat(obj.children||[])){const found=find(v,key);if(found)return found;}
    return null;
  };
  return {fire,render,find,$,values,get lastCall(){return lastCall;},get panel(){return panel;}};
}
test("/bro config saves backend, model and effort; subsequent simplify uses selected CLI",async()=>{
  const t=setup();
  await t.fire("session.start",{});
  assert.equal((await t.fire("command.run",{args:"config"},"bro")).text,"");
  assert.equal(t.panel,"bro_config_experimental");
  let pane=t.render(t.panel);
  t.find(pane,"choose_codex").onPress();
  pane=t.render(t.panel);
  t.find(pane,"bro_model").onInput("gpt-5.4");
  t.find(pane,"bro_effort").onSelect("high");
  pane=t.render(t.panel);
  await t.find(pane,"bro_save_config").onPress();
  await new Promise(resolve=>setImmediate(resolve));
  const saved=t.values.get("bro.claude.explain.backend.v1");
  assert.deepEqual(saved,{version:1,backend:"codex",model:"gpt-5.4",effort:"high"});
  await t.fire("turn.complete",{reason:"answer",answer:"source reply"});
  await t.fire("command.run",{args:"simplify"},"bro");
  assert.equal(t.lastCall.request.backend,"codex");
  assert.equal(t.lastCall.request.model,"gpt-5.4");
  assert.equal(t.lastCall.request.effort,"high");
  assert.ok(t.lastCall.request.prompt.includes("source reply"));
  assert.match(JSON.stringify(t.render("bro_simplify_experimental")),/Codex/);
});
test("bad Pi settings cannot be saved",async()=>{
  const t=setup();await t.fire("session.start",{});
  await t.fire("command.run",{args:"config"},"bro");
  t.find(t.render(t.panel),"choose_pi").onPress();
  await t.find(t.render(t.panel),"bro_save_config").onPress();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.values.size,0);
  assert.match(JSON.stringify(t.render(t.panel)),/provider\/model/);
});
