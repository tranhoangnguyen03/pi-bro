/** Source-focused Simplify modal. No chat thread, durable draft or new backend boundary. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { BtwModal } from "./btw.ts";
import { latestAssistant, simplify, type BroResult } from "./explain-modal.ts";
import { openBroOverlay } from "./modal-kit.ts";
import { nextBroMode, type BroMode } from "./prompt.ts";
import { readSettings } from "./settings.ts";
import { extractDocumentText, extractWebPage, type BroSource } from "./sources.ts";
import { hasBroCustomUi } from "./ui-capabilities.ts";
import { errorMessage, unquote } from "./util.ts";
import { parseSimplifyAction, SIMPLIFY_MODAL_HELP, type SimplifyAction } from "./simplify-engine.ts";

export type SimplifyState = {
  result?: BroResult;
  view?: "result" | "help" | "empty";
  draft?: string;
  error?: string;
};
export type SimplifyStart =
  | { kind:"resume" }
  | { kind:"latest" }
  | { kind:"text"|"file"|"url"; input:string };

async function resolveSource(ctx: ExtensionCommandContext, request: SimplifyStart | SimplifyAction,
  signal: AbortSignal, retained?: BroSource): Promise<BroSource> {
  if (retained) return retained;
  switch (request.kind) {
    case "latest": {
      await ctx.waitForIdle();
      if (signal.aborted) throw new Error("Cancelled.");
      const source=latestAssistant(ctx);
      if (!source) throw new Error("No completed assistant reply to simplify.");
      return {text:source.text,label:"Latest assistant reply"};
    }
    case "text": return {text:request.input,label:"Pasted text"};
    case "file": return {text:await extractDocumentText(request.input,ctx.cwd,signal),label:unquote(request.input)};
    case "url": return await extractWebPage(request.input,signal);
    default: throw new Error("Choose a source with /simplify, /text, /file or /url.");
  }
}

/** The state belongs to the parent /bro extension instance and resets on session_start. */
export async function openSimplifyWorkflow(
  ctx: ExtensionCommandContext,
  state: SimplifyState,
  initial: SimplifyStart,
): Promise<void> {
  if (!hasBroCustomUi(ctx)) {
    if (initial.kind==="resume") { ctx.ui.notify("Simplify's interactive view requires Pi TUI.", "warning"); return; }
    const controller=new AbortController();
    const source=await resolveSource(ctx,initial,controller.signal);
    const result=await simplify(source.text,controller.signal,await readSettings());
    state.result={source,...result};
    state.view="result"; state.error=undefined;
    return;
  }

  await openBroOverlay<void>(ctx,(tui,theme,_keys,done)=>{
    let closed=false;
    let controller:AbortController|undefined;
    let running=false;
    const close=()=>{if(closed)return; closed=true;state.draft=modal.getComposerText();controller?.abort();done(undefined);};
    const modal=new BtwModal(tui,theme,close,submit,()=>{
      closed=true;state.draft=modal.getComposerText();controller?.abort();
    },{
      title:"Bro · simplify",
      commands:"",
      inputLabel:"Simplify command",
      idleHint:"Enter run · M change mode · R retry · /copy · /help · Esc close",
    });
    const display=()=>{
      modal.setCustomMode(state.result?.mode ? state.result.mode+(state.result.preferences ? " · prefs" : "") : "one source · one explanation");
      modal.setModel(state.result?.model ?? "");
      if(state.view==="help")modal.setText(SIMPLIFY_MODAL_HELP);
      else if(state.view==="result"&&state.result)modal.setText((state.result.source.label ? "**Source:** "+stripVTControlCharacters(state.result.source.label).replace(/[\r\n]/g," ")+"\n\n---\n\n" : "")+state.result.text);
      else modal.setText("## Simplify\n\nUse /simplify for the latest reply, /text, /file or /url for another source. Type /help for all commands.");
      // Notices describe the currently shown state, not an earlier request.\n      modal.setNotice(state.error ?? "",state.error ? "error" : "info");
      modal.scrollToEnd();
    };
    const run=async (request:SimplifyStart|SimplifyAction, retained?:BroSource, mode?:BroMode, submitted?:string)=>{
      if(running||closed)return;
      const attempt=new AbortController();
      controller=attempt; running=true;
      modal.setRunning(true);modal.setNotice("Simplifying…");
      const previous=state.result,previousView=state.view;
      try {
        const source=await resolveSource(ctx,request,attempt.signal,retained);
        if(closed||attempt.signal.aborted)return;
        const currentSettings=await readSettings();
        const result=await simplify(source.text,attempt.signal,currentSettings,text=>{
          if(!closed&&!attempt.signal.aborted)modal.setText(text);
        },mode);
        if(closed||attempt.signal.aborted)return;
        state.result={source,...result};
        state.view="result";state.error=undefined;
        display();
        if(mode && mode !== currentSettings.mode)modal.setNotice("Mode: "+mode+" (not saved)");
      } catch(error){
        if(closed||attempt.signal.aborted)return;
        state.result=previous;state.view=previousView;
        state.error=errorMessage(error);
        display();
        // Failed replacement is editable and retryable. Do not overwrite text the user\n        // entered while this request was running. Preserve it on modal close as well.\n        if(submitted && !modal.getComposerText().trim()) {\n          modal.setComposerText(submitted);\n          state.draft=submitted;\n        }
      } finally {
        if(controller===attempt)controller=undefined;
        running=false;
        if(!closed)modal.setRunning(false);
      }
    };
    const retry=(switchMode=false)=>{
      if(running||!state.result)return;
      const next=switchMode?nextBroMode(state.result.mode??"balanced"):state.result.mode;
      void run({kind:"latest"},state.result.source,next);
    };
    const copy=()=>{
      if(!state.result?.text){modal.setNotice("Nothing to copy yet.","warning");return;}
      void copyToClipboard(state.result.text)
        .then(()=>{if(!closed)modal.setNotice("Explanation copied.","success");})
        .catch(error=>{if(!closed)modal.setNotice("Copy failed: "+errorMessage(error),"error");});
    };
    function submit(raw:string):void {
      if(running||closed)return;
      const action=parseSimplifyAction(raw);
      if(action.kind==="invalid"){modal.setNotice(action.message,"warning");return;}
      modal.clearComposer();state.draft=undefined;
      if(action.kind==="copy"){copy();return;}
      if(action.kind==="clear"){
        state.result=undefined;state.view="empty";state.error=undefined;display();return;
      }
      if(action.kind==="help"){state.view="help";state.error=undefined;display();return;}
      if(action.kind==="retry"){retry();return;}
      void run(action,undefined,undefined,raw);
    }
    modal.onKey=(data:string)=>{
      if(running||modal.getComposerText().trim())return false;
      if(matchesKey(data,"m")||matchesKey(data,"shift+m")){retry(true);return Boolean(state.result);}
      if(matchesKey(data,"r")||matchesKey(data,"shift+r")){retry();return Boolean(state.result);}
      if(matchesKey(data,"c")||matchesKey(data,"shift+c")){copy();return true;}
      return false;
    };
    display();
    if(state.draft)modal.setComposerText(state.draft);
    if(initial.kind!=="resume")queueMicrotask(()=>{if(!closed)void run(initial,undefined,undefined,
      initial.kind==="latest" ? "/simplify" : "/"+initial.kind+" "+initial.input);});
    return modal;
  },{mouse:true});
}
