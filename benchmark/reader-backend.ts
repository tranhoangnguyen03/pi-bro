import { execute, CLAUDE_EFFORTS, CODEX_EFFORTS, MUSE_EFFORTS, type BackendSelection } from '../backend.ts';
import { executeIsolatedCall, type ManifestRow, type BenchmarkResult } from './run.ts';

export function generatorSettings(value:any) {
 const backend=value?.backend??'agy';
 const efforts=backend==='agy'?['low','medium','high']:backend==='claude'?CLAUDE_EFFORTS:backend==='codex'?CODEX_EFFORTS:backend==='muse'?MUSE_EFFORTS:[];
 if(typeof value?.model!=='string'||!value.model.trim()||!efforts.includes(value.effort)||!Number.isInteger(value.timeoutMs)||value.timeoutMs<=0||value.timeoutMs>2147483647)throw new Error('Invalid generator settings');
 return {backend,model:value.model,effort:value.effort,timeoutMs:value.timeoutMs};
}
export async function generateReader(row: ManifestRow, prompt: string, signal: AbortSignal, backend = 'agy'): Promise<BenchmarkResult & {backend:string;generator:ReturnType<typeof generatorSettings>}> {
 const generator=generatorSettings({...row,backend});
 if (backend === 'agy') return {...await executeIsolatedCall(row, prompt, signal),backend,generator};
 const start = Date.now();
 const result = await execute({feature:'explain',access:'restricted',prompt}, {backend,model:row.model,effort:row.effort} as BackendSelection, signal, undefined, {deadlineMs:row.timeoutMs});
 return {backend,generator,callId:row.callId,fixture:row.fixture,variant:row.variant,model:row.model,effort:row.effort,elapsedMs:Date.now()-start,
  outcome:result.status==='failure'?'error':result.status,stopReason:result.status==='success'?'stop':result.status,
  output:result.status==='success'?result.text:result.partialText??'',...(result.status==='success'?{}:{error:result.message})};
}
