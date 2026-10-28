// Home page background: the Satin silk shader from the MIT Shaders library, same treatment as the
// xyznot.com company page. The static poster stays visible without WebGPU or JavaScript.
import { createShader } from 'shaders/js';
import Satin from 'shaders/core/Satin';

const canvas = document.querySelector('#silk');
const motion = document.querySelector('#motion');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let shader;
let paused = reducedMotion.matches;
let disposed = false;

function syncMotion() {
  motion.setAttribute('aria-pressed', String(paused));
  motion.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
  if (!shader) return;
  if (paused || document.hidden) shader.pause();
  else shader.resume();
}
function fallback() {
  document.documentElement.classList.remove('shader-ready');
  motion.hidden = true;
}
motion.addEventListener('click', () => { paused = !paused; syncMotion(); });
reducedMotion.addEventListener('change', () => { paused = reducedMotion.matches; syncMotion(); });
document.addEventListener('visibilitychange', syncMotion);
window.addEventListener('pagehide', (event) => {
  shader?.pause();
  if (!event.persisted) { disposed = true; shader?.destroy(); }
});
window.addEventListener('pageshow', syncMotion);

async function start() {
  if (!navigator.gpu) return;
  try {
    shader = await createShader(canvas, {
      components: [{ type: 'Satin', id: 'silk', props: {
        color: '#291c15', highlightColor: '#dfb689', foldCount: 5,
        foldDirection: 18, foldDepth: .75, foldWidth: .24, pinning: .15,
        seed: 31, speed: .3, breeze: .35, gloss: .65, anisotropy: .8,
        bloom: .35, sheen: .5, weave: .045, fiberAngle: 18,
        lightAngle: 225, fill: .2,
      }}],
    }, {
      components: [Satin], disableTelemetry: true, observeElement: false,
      onReady() {
        if (disposed) return;
        document.documentElement.classList.add('shader-ready');
        motion.hidden = false;
        syncMotion();
      },
      onError: fallback,
    });
    if (disposed) { shader.destroy(); return; }
    if (shader.getFailureReason()) fallback();
    syncMotion();
    // Bound the artwork resolution; text stays at native display resolution.
    function resize() {
      const ratio = Math.min(1, 1600 / innerWidth, 1100 / innerHeight);
      shader.resize(Math.round(innerWidth * ratio / devicePixelRatio), Math.round(innerHeight * ratio / devicePixelRatio));
      syncMotion();
    }
    addEventListener('resize', resize);
    resize();
  } catch { fallback(); }
}
start();
