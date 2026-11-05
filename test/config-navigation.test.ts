import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_ROOT,CONFIG_GLOBAL,CONFIG_FEATURES,
  effectiveConfigLabel,inheritedConfigDescription,configFeatureAccessNote,
} from "../src/config-navigation.ts";
import type {BroSettings} from "../src/settings.ts";

const settings:BroSettings={
  backend:"agy",model:"gemini-default",effort:"low",mode:"balanced",showTurns:3,
  overrides:{ btw:{backend:"pi",model:"anthropic/specified-model",effort:"high"},
    show:{backend:"codex",model:"gpt-example",effort:"medium"} },
};

test("Config root has Global and Features, with the eight actual feature names",()=>{
 assert.deepEqual(CONFIG_ROOT.map(x=>x.value),["global","features"]);
 assert.deepEqual(CONFIG_GLOBAL.map(x=>x.value),["defaults","preferences","doctor"]);
 assert.deepEqual(CONFIG_FEATURES.map(x=>x.value),[
  "explain","show","btw","review","advisor","elevate","grill-me","remember-me",
 ]);
});

test("Global defaults and feature overrides have distinct, truthful effective labels",()=>{
 assert.match(effectiveConfigLabel(settings,"explain"),/agy \/ gemini-default \/ low \(global default\)/);
 assert.match(effectiveConfigLabel(settings,"show"),/codex \/ gpt-example \/ medium \(override\)/);
 assert.match(effectiveConfigLabel(settings,"btw"),/pi \/ anthropic\/specified-model \/ high \(override\)/);
 for(const feature of ["elevate","grill-me","remember-me"] as const){
   const description=inheritedConfigDescription(settings,feature);
   assert.match(description,/inherits BTW/);
   assert.match(description,/anthropic\/specified-model/);
   assert.match(description,/No separate override exists/);
 }
 assert.deepEqual(Object.keys(settings.overrides).sort(),["btw","show"],"navigation must not create extra settings");
});


test("BTW and Guided Review disclosures track each selected backend without new permission controls",()=>{
  const cases=[
    {backend:"agy",btw:/sandbox.*not a no-write guarantee/,review:/writes allowed/},
    {backend:"claude",btw:/disables tools/,review:/Read\/Grep\/Glob.*no shell/},
    {backend:"grok",btw:/sandbox stays off and permissions are bypassed/,review:/read-only sandbox/},
    {backend:"codex",btw:/read-only sandbox.*not tool-free/,review:/read-only sandbox/},
    {backend:"muse",btw:/disables shell, write and approvals/,review:/disables shell, writes and web/},
    {backend:"pi",btw:/no tools, extensions or context files/,review:/read\/grep\/find\/ls.*no shell/},
  ] as const;
  for(const x of cases){
    const current={...settings,overrides:{
      ...settings.overrides,
      btw:{backend:x.backend,model:"test-model",effort:"default" as const},
      review:{backend:x.backend,model:"test-model",effort:"default" as const},
    }} as BroSettings;
    assert.match(configFeatureAccessNote(current,"btw"),x.btw,"BTW "+x.backend);
    assert.match(configFeatureAccessNote(current,"review"),x.review,"review "+x.backend);
    assert.match(configFeatureAccessNote(current,"btw"),/full workspace access/);
    assert.match(configFeatureAccessNote(current,"review"),/Guided Review/);
  }
});
