import * as A from '../public/js/abc.js';
const eq=(a,b)=>{ if(a!==b){console.log('FAIL',JSON.stringify(a),'!=',JSON.stringify(b)); process.exitCode=1}};
eq(A.midiToAbc(60),'C'); eq(A.midiToAbc(72),'c'); eq(A.midiToAbc(84),"c'"); eq(A.midiToAbc(59),'B,'); eq(A.midiToAbc(61),'^C');
eq(A.shiftPitch('B',1),'c'); eq(A.shiftPitch('c',-1),'B'); eq(A.shiftPitch('"Am"^F2',1),'"Am"G2'); eq(A.shiftPitch('[CEG]2',1),'[DFA]2');
eq(A.setPitchLetter('z2','E'),'E2'); eq(A.setPitchLetter('c2','B'),'B2'); eq(A.setPitchLetter('C','D'),'D');
eq(A.setDuration('C2-','/2'),'C/2-'); eq(A.setDuration('[CEG]2','4'),'[CEG]4'); eq(A.toRest('[CEG]3/2'),'z3/2');
eq(A.durationSuffix(1,4,'L:1/8'),'2'); eq(A.durationSuffix(1,16,'L:1/8'),'/'); eq(A.durationSuffix(3,8,'L:1/4'),'3/2'); eq(A.durationSuffix(1,8,'L:1/8'),'');
eq(A.toggleAccidental('C','^'),'^C'); eq(A.toggleAccidental('^C','^'),'C');
if(!process.exitCode) console.log('abc helpers: all passed');
