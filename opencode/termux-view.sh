#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE=".builder/live/state.json"
while true; do
  if [ -f "$STATE_FILE" ]; then
    node -e "
      const fs=require('fs');
      const s=JSON.parse(fs.readFileSync('.builder/live/state.json'));
      const fmt=(n)=>n.toString().padStart(2,'0');
      const ms=s.elapsedMs||0; const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),sec=Math.floor((ms%60000)/1000);
      console.clear();
      console.log('PROJECT:', s.projectState, '|', s.overallProgressPct+'%', '|', 'F:'+s.completedFeatures+'/'+s.totalFeatures, '| T:'+s.completedTasks+'/'+s.totalTasks);
      console.log('Elapsed:', h+':'+fmt(m)+':'+fmt(sec), '| Latest:', s.latestActivity);
      console.log('Agents:', 'active='+s.activeAgents, 'waiting='+s.waitingAgents, 'blocked='+s.blockedAgents);
      console.log('Cloud:', s.cloudBuild.stage, s.cloudBuild.status, '| APK:', s.apkVerification, '| Release:', s.release.status);
      if(s.finalDownloadUrl||s.release.assetUrl) console.log('DOWNLOAD:', s.finalDownloadUrl||s.release.assetUrl);
      if(s.failureRepair&&s.failureRepair.state!=='idle') console.log('REPAIR:', s.failureRepair.state);
    "
  else
    echo "Waiting for live state..."
  fi
  sleep 2
done
