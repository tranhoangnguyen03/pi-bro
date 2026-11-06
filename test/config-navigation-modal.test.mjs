import {test} from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {initTheme} from "@earendil-works/pi-coding-agent";
import {buildDir} from "./test-build.mjs";

const {createConfigNavigationModal}=await import(pathToFileURL(join(buildDir,"config-navigation-ui.js")).href);
const {createConfigModal}=await import(pathToFileURL(join(buildDir,"config-ui.js")).href);
initTheme();
const settings={backend:"agy",model:"default-model",effort:"low",mode:"balanced",showTurns:1,
 overrides:{btw:{backend:"pi",model:"anthropic/picked",effort:"high"}}};
const tui={mode:"regular",terminal:{rows:34,columns:100,write(){}},requestRender(){}};
const theme={fg:(_color,text)=>text,bold:text=>text};
const enter="\r",esc="\x1b",down="\x1b[B";
const mount=state=>{
 let result;
 const component=createConfigNavigationModal(state,settings)(tui,theme,{},value=>{result=value;});
 return {component, result:()=>result};
};

test("Config root enters Global, Esc backs out, and defaults opens existing editor",()=>{
 const state={screen:"root"};
 const m=mount(state);
 assert.ok(m.component.render(100).join("\n").includes("Bro · config"));
 m.component.handleInput(enter);
 assert.equal(state.screen,"global");
 m.component.handleInput(esc);
 assert.equal(state.screen,"root");
 m.component.handleInput(enter);
 m.component.handleInput(enter);
 assert.deepEqual(m.result(),{kind:"settings",page:"defaults"});
});

test("Doctor is a leaf action; it never runs merely from opening Config",()=>{
 const state={screen:"root"},m=mount(state);
 m.component.handleInput(enter);
 m.component.handleInput(down);
 m.component.handleInput(down);
 m.component.handleInput(enter);
 assert.deepEqual(m.result(),{kind:"doctor"});
});

test("Features includes inherited pages and identifies BTW as their backend owner",()=>{
 const state={screen:"root"},m=mount(state);
 m.component.handleInput(down);
 m.component.handleInput(enter);
 assert.equal(state.screen,"features");
 for(let i=0;i<5;i++)m.component.handleInput(down);
 m.component.handleInput(enter);
 assert.equal(state.screen,"inherited");
 assert.match(m.component.render(100).join("\n"),/inherits BTW/);
 m.component.handleInput(esc);
 assert.equal(state.screen,"features");
});


test("BTW and Review editing pages visibly disclose selected backend permissions",()=>{
  const sample={...settings,overrides:{
    ...settings.overrides,
    btw:{backend:"grok",model:"grok-test",effort:"low"},
    review:{backend:"codex",model:"codex-test",effort:"low"}
  }};
  const btw=createConfigModal(sample,[],async()=>{},[],"btw")(tui,theme,{},()=>{});
  const btwScreen=btw.render(100).join("\n");
  assert.match(btwScreen,/sandbox stays off/);
  assert.match(btwScreen,/permission/);
  const review=createConfigModal(sample,[],async()=>{},[],"review")(tui,theme,{},()=>{});
  const reviewScreen=review.render(100).join("\n");
  assert.match(reviewScreen,/read-only sandbox/);
  assert.match(reviewScreen,/Captured|Guide|Review/);
});


test("Features > Overthink opens global question editor, not a model picker", () => {
  const state = { screen: "root" }, m = mount(state);
  m.component.handleInput(down); m.component.handleInput(enter);
  for (let i = 0; i < 8; i++) m.component.handleInput(down);
  m.component.handleInput(enter);
  assert.deepEqual(m.result(), { kind: "overthink-defaults" });
});
