const fs = require('fs');
const path = require('path');

function replaceInFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    content = content.replace(/ReviewCode Review Bot/g, 'ReviewCode');
    content = content.replace(/ReviewCode Review/g, 'ReviewCode');

    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('Updated', filePath);
    }
}

function traverseDir(dir) {
    fs.readdirSync(dir).forEach(file => {
        let fullPath = path.join(dir, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
            if (file === 'node_modules' || file === '.next' || file === '.git' || file === 'dist' || file === 'tests') return;
            traverseDir(fullPath);
        } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') || fullPath.endsWith('.md')) {
            replaceInFile(fullPath);
        }
    });
}

traverseDir(path.resolve('.'));
