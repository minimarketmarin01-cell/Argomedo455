import fs from 'fs'; import * as acorn from 'acorn'; import * as walk from 'acorn-walk';
const f=process.argv[2]; const src=fs.readFileSync(f,'utf8');
const ast=acorn.parse(src,{ecmaVersion:'latest',sourceType:'module',locations:true});
const SQL=/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH|REPLACE)\b/i;
// aplana concatenaciones '+' en un solo texto; lo no literal queda como {{expr}}
function aplana(n){
  if(n.type==='Literal'&&typeof n.value==='string')return n.value;
  if(n.type==='TemplateLiteral'){let s='';n.quasis.forEach((q,i)=>{s+=q.value.cooked;if(n.expressions[i])s+='{{'+src.slice(n.expressions[i].start,n.expressions[i].end)+'}}';});return s;}
  if(n.type==='BinaryExpression'&&n.operator==='+'){const a=aplana(n.left),b=aplana(n.right);return (a===null?'{{'+src.slice(n.left.start,n.left.end)+'}}':a)+(b===null?'{{'+src.slice(n.right.start,n.right.end)+'}}':b);}
  return null;
}
const out=[];const vistos=new Set();
walk.ancestor(ast,{
  Literal(n,_,anc){take(n,anc)},TemplateLiteral(n,_,anc){take(n,anc)},BinaryExpression(n,_,anc){take(n,anc)}
});
function take(n,anc){
  // solo la expresión más externa de una concatenación
  const p=anc[anc.length-2]; if(p&&p.type==='BinaryExpression'&&p.operator==='+')return;
  const s=aplana(n); if(s===null||!SQL.test(s))return;
  const k=n.start; if(vistos.has(k))return; vistos.add(k);
  out.push({line:n.loc.start.line,sql:s});
}
fs.writeFileSync(process.argv[3],JSON.stringify(out,null,1));
console.log(out.length,'sentencias');
