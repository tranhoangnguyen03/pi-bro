/** Compact navigation over existing settings/editors; no separate configuration state. */
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { SelectList, matchesKey, wrapTextWithAnsi, type SelectItem, type Component } from "@earendil-works/pi-tui";
import { delegateMouse, modalHeight, renderFrame, type Theme, type TuiLike, type Area } from "./modal-kit.ts";
import type { BroMouseEvent } from "./ui-capabilities.ts";
import type { BroSettings } from "./settings.ts";
import {
  CONFIG_ROOT, CONFIG_GLOBAL, CONFIG_FEATURES,
  inheritedConfigDescription,
  type ConfigNavAction, type ConfigNavState, type ConfigNavScreen,
} from "./config-navigation.ts";

type MenuItem = {value:string;label:string};
const rowsFor=(screen:ConfigNavScreen):readonly MenuItem[]=>{
  if(screen==="root")return CONFIG_ROOT;
  if(screen==="global")return CONFIG_GLOBAL;
  if(screen==="features")return CONFIG_FEATURES;
  if(screen==="advisor")return [
    {value:"advisor-settings",label:"Backend, model and effort"},
    {value:"advisor-steer",label:"Persistent advisor steering brief"},
  ];
  return [{value:"btw-settings",label:"Open BTW's inherited backend settings"}];
};

export function createConfigNavigationModal(
  state:ConfigNavState,
  settings:BroSettings,
): (tui:TuiLike,theme:Theme,keys:unknown,done:(result:ConfigNavAction)=>void)=>Component {
  return (tui,theme,_keys,done)=>{
    let closed=false;
    let list:SelectList;
    let listArea:Area={top:0,left:0,width:0,height:0};
    const finish=(result:ConfigNavAction)=>{if(closed)return;closed=true;done(result);};
    const go=(screen:ConfigNavScreen)=>{
      state.screen=screen;
      const items=rowsFor(screen) as SelectItem[];
      list=new SelectList(items,Math.min(items.length,Math.max(1,modalHeight(tui)-10)),getSelectListTheme());
      list.onSelect=item=>choose(item.value);
      list.onCancel=back;
      tui.requestRender();
    };
    const back=()=>{
      if(state.screen==="root")return finish({kind:"close"});
      if(state.screen==="global"||state.screen==="features"){go("root");return;}
      go("features");
    };
    const choose=(value:string)=>{
      if(state.screen==="root"){go(value==="global"?"global":"features");return;}
      if(state.screen==="global"){
        if(value==="defaults")return finish({kind:"settings",page:"defaults"});
        if(value==="preferences")return finish({kind:"preferences"});
        if(value==="doctor")return finish({kind:"doctor"});
      }
      if(state.screen==="features"){
        if(value==="advisor"){go("advisor");return;}
        if(value==="elevate"||value==="grill-me"||value==="remember-me"||value==="architecture"){
          state.inherited=value;go("inherited");return;
        }
        if(value==="explain"||value==="show"||value==="btw"||value==="review")return finish({kind:"settings",page:value});
      }
      if(state.screen==="advisor"){
        if(value==="advisor-steer")return finish({kind:"advisor-steer"});
        if(value==="advisor-settings")return finish({kind:"settings",page:"advisor"});
      }
      if(state.screen==="inherited"&&value==="btw-settings"){
        state.screen="features";return finish({kind:"settings",page:"btw"});
      }
    };
    go(state.screen);
    const title=()=>{
      const s=state.screen;
      return s==="root"?"Bro · config":
        s==="global"?"Bro · config / Global":
        s==="features"?"Bro · config / Features":
        s==="advisor"?"Bro · config / Features / Advisor":
        "Bro · config / Features / "+(state.inherited??"Inherited");
    };
    const subtitle=()=>{
      if(state.screen==="root")return "Choose Global or Features. Enter drill down · Esc close.";
      if(state.screen==="global")return "Defaults are shared. Doctor runs only when selected.";
      if(state.screen==="features")return "Feature model overrides are optional; inherited features use BTW.";
      if(state.screen==="advisor")return "Steering keeps its own file; changing models does not change steering.";
      if(state.inherited)return inheritedConfigDescription(settings,state.inherited);
      return "Inherits BTW";
    };
    return {
      render:(width:number)=>{
        const h=modalHeight(tui),w=Math.max(1,width-2),lines=list.render(w);
        // Derive mouse hit area from the same subtitle lines we render, including long
        // inherited-backend descriptions and narrow-terminal layouts.
        const subtitleLines=wrapTextWithAnsi(theme.fg("dim",subtitle()),w).slice(0,Math.max(0,h-5-lines.length));
        listArea={top:3+subtitleLines.length,left:1,width:w,height:Math.max(0,Math.min(lines.length,h-5-subtitleLines.length))};
        return renderFrame(theme,width,h,{
          header:()=>theme.fg("accent",theme.bold(title())),
          body:()=>[...subtitleLines,...lines],
          hints:"↑/↓ select · Enter open · Esc back",
          fill:false,
          minBody:Math.max(1,lines.length),
        });
      },
      invalidate:()=>list.invalidate(),
      handleMouse:(event:BroMouseEvent)=>delegateMouse(list,event,listArea),
      handleInput:(data:string)=>{
        if(matchesKey(data,"escape")){back();return;}
        list.handleInput(data);
        tui.requestRender();
      },
    };
  };
}
