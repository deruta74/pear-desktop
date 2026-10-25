// The fixture substitutes only the PCM/media-volume source and parameter receipt
// acknowledgement. Production graph, DSP, filters, EQ and controllers run natively.
export const reverbNativeSource = `
import {createSlowedReverbController} from '@/plugins/player-actions/slowed-reverb/controller';
import {EqualizerController} from '@/plugins/equalizer/controller';
import {initializeAudioGraph} from '@/providers/renderer-audio';
import {DATTORRO_WORKLET_SOURCE} from '@/plugins/player-actions/slowed-reverb/worklet';
export async function renderReverbStress(options={}) {
  const {intensity=1,volume=1,frequency=1000,kind='sine',eq='off',highpass=180,lowpass=6500,changes=false,transitionIntensity=null,changeVolume=null,changeHighpass=null,changeLowpass=null,changeAt=1,interruptedIntensity=null,captureTransition=false,auditRamp=false}=options;
  const rate=48000, seconds=8, context=new OfflineAudioContext(2,rate*seconds,rate);
  const video=document.querySelector('video');video.volume=volume;
  const source=context.createBufferSource(), buffer=context.createBuffer(2,rate*seconds,rate);
  let seed=1234567, pink=[0,0];
  for(let c=0;c<2;c++) {
    const samples=buffer.getChannelData(c);let peak=0;
    for(let i=0;i<rate*4;i++) {
      let x;
      if(kind==='impulse') x=i===0?1:0;
      else if(kind==='music') x=.4*Math.sin(2*Math.PI*83*i/rate)+.3*Math.sin(2*Math.PI*600*i/rate)+.2*Math.sin(2*Math.PI*(1000+c*137)*i/rate)+.1*Math.sin(2*Math.PI*6000*i/rate);
      else if(kind==='pink') {seed=(Math.imul(seed,1664525)+1013904223)|0;pink[c]=.98*pink[c]+.02*(seed/2147483648);x=pink[c];}
      else x=Math.sin(2*Math.PI*frequency*i/rate);
      samples[i]=x;peak=Math.max(peak,Math.abs(x));
    }
    if(peak)for(let i=0;i<rate*4;i++)samples[i]*=.99/peak;
  }
  source.buffer=buffer;
  const mediaVolume=context.createGain();mediaVolume.gain.value=volume;source.connect(mediaVolume);
  Object.defineProperty(mediaVolume,'mediaElement',{value:video});
  const graph=initializeAudioGraph(context,mediaVolume);
  const originalConnect=mediaVolume.connect.bind(mediaVolume),originalDisconnect=mediaVolume.disconnect.bind(mediaVolume);
  const sourceEdges=new Set([graph.dryInput]);let wetConnections=0;
  mediaVolume.connect=(node,...args)=>{if(!sourceEdges.has(node))wetConnections++;sourceEdges.add(node);return originalConnect(node,...args);};
  mediaVolume.disconnect=(node,...args)=>{if(node)sourceEdges.delete(node);else sourceEdges.clear();return node?originalDisconnect(node,...args):originalDisconnect();};
  const addModule=context.audioWorklet.addModule.bind(context.audioWorklet);
  context.audioWorklet.addModule=async()=>{
    const body=DATTORRO_WORKLET_SOURCE.replace("registerProcessor('dattorro-reverb', DattorroReverbProcessor);", "class Ready extends DattorroReverbProcessor {handleMessage(data){super.handleMessage(data);if(data.type==='setParams')this.port.postMessage('ready')}};registerProcessor('dattorro-reverb',Ready);");
    const url=URL.createObjectURL(new Blob([body],{type:'application/javascript'}));try{await addModule(url);}finally{URL.revokeObjectURL(url);}
  };
  const wet=createSlowedReverbController();
  wet.ctx={getConfig:()=>wet.config,setConfig:()=>{}};
  wet.config={active:true,slow:1,reverbIntensity:intensity,wetHighpass:highpass,wetLowpass:lowpass};
  wet.wireAudio(context,mediaVolume);await wet.ensureWorklet();
  const acknowledge=()=>new Promise(resolve=>{const previous=wet.reverbNode.port.onmessage;wet.reverbNode.port.onmessage=e=>{previous?.(e);if(e.data==='ready')resolve();};wet.applyReverb();});
  await acknowledge();const initialNode=wet.reverbNode;
  let equalizer;
  if(eq!=='off') {equalizer=new EqualizerController(graph);equalizer.apply({mode:'custom',preamp:0,bands:eq==='boost'?[{id:'peak',type:'peaking',frequency:frequency,gain:18,Q:1}]:[]},false,true);}
  for(const i of [intensity,.35,.4,1,intensity])wet.onConfigChange({...wet.config,reverbIntensity:i});
  await acknowledge();
  const pause=changes?context.suspend(changeAt):null;
  const interruption=changes&&(interruptedIntensity!==null||auditRamp)?context.suspend(changeAt+.01):null;
  const afterRamp=auditRamp?context.suspend(changeAt+.05):null;
  const rampAudit=[];
  const audit=label=>rampAudit.push({label,time:context.currentTime,reserved:wet.reservedWetPeak,target:wet.wetPeakReserve,masterGain:graph.masterInput.gain.value,wetGain:wet.wetGain?.gain.value,envelope:{...wet.wetEnvelope}});
  source.start();const rendering=context.startRendering();
  if(pause){
    await pause;
    if(transitionIntensity===null)for(const i of [.4,1,.35,intensity])wet.onConfigChange({...wet.config,reverbIntensity:i});
    else wet.onConfigChange({...wet.config,reverbIntensity:transitionIntensity,...(changeHighpass===null?{}:{wetHighpass:changeHighpass}),...(changeLowpass===null?{}:{wetLowpass:changeLowpass})});
    if(changeVolume!==null){video.volume=changeVolume;mediaVolume.gain.setValueAtTime(changeVolume,context.currentTime);video.dispatchEvent(new Event('volumechange'));}
    if(wet.reverbNode)await acknowledge();
    if(auditRamp){audit('ack-before-audio');await new Promise(resolve=>setTimeout(resolve,30));audit('paused-wall-time');}
    await context.resume();
  }
  if(interruption){await interruption;if(auditRamp)audit('ten-ms');if(interruptedIntensity!==null){wet.onConfigChange({...wet.config,reverbIntensity:interruptedIntensity});if(wet.reverbNode)await acknowledge();}await context.resume();}
  if(afterRamp){await afterRamp;await new Promise(resolve=>setTimeout(resolve,0));audit('after-ramp');await context.resume();}
  const audio=await rendering;let peak=0,peakTime=0,transitionPeak=0,energy=0,tail=0,late=0,finite=true;
  for(let c=0;c<2;c++)for(let i=0;i<rate*seconds;i++){const x=audio.getChannelData(c)[i];finite&&=Number.isFinite(x);if(Math.abs(x)>peak){peak=Math.abs(x);peakTime=i/rate;}if(i>=rate&&i<rate*1.25)transitionPeak=Math.max(transitionPeak,Math.abs(x));if(i>=rate&&i<rate*4)energy+=x*x;if(i>=rate*4&&i<rate*6)tail+=x*x;if(i>=rate*6)late+=x*x;}
  const gain=graph.masterInput.gain.value,masterPeak=graph.masterSourcePeak,preamp=equalizer?.getResponse().effectivePreampDb;
  const sameNode=initialNode===wet.reverbNode, liveEdges=sourceEdges.size;
  wet.stop();equalizer?.stop();
  return {rampAudit,transitionSamples:captureTransition?[0,1].map(c=>Array.from(audio.getChannelData(c).subarray(Math.floor((changeAt-.02)*rate),Math.floor((changeAt+.12)*rate)))):null,peak,peakTime,transitionPeak,rms:Math.sqrt(energy/(rate*6)),tail,late,finite,gain,masterPeak,preamp,sameNode,wetConnections,liveEdges,retiredEdges:sourceEdges.size,afterStopGain:graph.masterInput.gain.value};
}
`;
