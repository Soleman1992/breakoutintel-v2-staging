const {execSync}=require('child_process');
const cwd='c:/Users/sazad/Documents/BREAKOUT/breakoutintel-v2';
try{
  execSync('git add backend/src/index.js',{cwd,stdio:'inherit'});
  execSync('git commit -m "fix: dynamic REPO_ROOT detection for Render vs local"',{cwd,stdio:'inherit'});
  execSync('git push origin main',{cwd,stdio:'inherit'});
  console.log('Done!');
}catch(e){console.error(e.message);}
