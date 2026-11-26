// The first MusicXML rootfile in an MXL container is its primary score.
import { h } from './lib.js';
let loading;
export async function unpackMxl(bytes) {
  loading ??= new Promise((resolve, reject) => {
    const script = h('script', { src: '/vendor/jszip.min.js' });
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => { loading = undefined; reject(new Error('Could not load the MXL reader.')); };
    document.head.append(script);
  });
  const zip = await (await loading).loadAsync(bytes);
  const manifest = zip.file('META-INF/container.xml');
  if (!manifest) throw new Error('The MXL archive is missing its container manifest.');
  const parser = new DOMParser();
  const doc = parser.parseFromString(await manifest.async('string'), 'application/xml');
  const path = doc.querySelector('rootfiles > rootfile')?.getAttribute('full-path');
  const score = path && zip.file(path);
  if (!score) throw new Error('The MXL archive is missing its primary score.');
  const xml = await score.async('string');
  const root = parser.parseFromString(xml, 'application/xml').documentElement;
  if (!['score-partwise', 'score-timewise'].includes(root.localName)) throw new Error('The archive contains invalid MusicXML.');
  return xml;
}
