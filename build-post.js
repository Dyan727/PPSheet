const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dist = path.join(__dirname, 'dist');
if (!fs.existsSync(dist)) fs.mkdirSync(dist);

// VBScript launcher — runs PPSheet.exe hidden (no console window)
const vbs = `Dim exePath
exePath = Replace(WScript.ScriptFullName, "PPSheet.vbs", "PPSheet.exe")
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & exePath & Chr(34), 0, False
`;
fs.writeFileSync(path.join(dist, 'PPSheet.vbs'), vbs);

// Convert logo.png to proper multi-resolution .ico and embed into EXE via rcedit


console.log('\nBuild complete! Output in dist/');
console.log('  PPSheet.exe   — the server');
console.log('  PPSheet.vbs   — double-click this to launch silently');
