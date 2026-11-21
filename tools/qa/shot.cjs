const { chromium, devices } = require('playwright');
(async()=>{const b=await chromium.launch();
 const d=await b.newContext({viewport:{width:1280,height:800}}); const p=await d.newPage(); const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
 await p.goto('http://localhost:4173/login'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(500);
 console.log('fonts', await p.evaluate(()=>[...document.fonts].filter(f=>f.family.includes('Cormorant')).map(f=>f.status).join(',')), 'links', await p.evaluate(()=>[...document.styleSheets].map(s=>s.href).join(' ')));
 await p.screenshot({path:'login.png'}); console.log('errors',errs);
 await b.close();})();
