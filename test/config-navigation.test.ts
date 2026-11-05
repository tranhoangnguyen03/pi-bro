import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_ROOT,CONFIG_GLOBAL,CONFIG_FEATURES,
  effectiveConfigLabel,inheritedConfigDescription,
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
