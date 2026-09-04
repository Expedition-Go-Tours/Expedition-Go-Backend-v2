const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = async function() {
  const prismaClientPath = path.join(__dirname, 'node_modules', '.prisma', 'client', 'default.js');
  if (!fs.existsSync(prismaClientPath)) {
    console.log('Generating Prisma client...');
    execSync('npx prisma generate', { stdio: 'inherit' });
  }
};
