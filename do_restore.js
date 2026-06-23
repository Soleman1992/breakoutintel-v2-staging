const {execSync}=require('child_process');
const cwd='c:/Users/sazad/Documents/BREAKOUT/breakoutintel-v2';
try{
  execSync('git reset --hard 883027058de3fc829b7d3b79976337417a557581',{cwd,stdio:'inherit'});
  execSync('git push origin main --force',{cwd,stdio:'inherit'});
  console.log('Done! Restored to original version 8830270');
}catch(e){console.error(e.message);}
