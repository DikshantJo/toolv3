#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

console.log('🔍 Testing GitHub Code Review Bot Setup...\n');

// Test 1: Check if all required files exist
console.log('1. Checking required files...');
const requiredFiles = [
  'code-review-tool/package.json',
  'code-review-tool/config/review-criteria.yml',
  'code-review-tool/scripts/code-review.js',
  '.github/workflows/code-review-development.yml',
  '.github/workflows/code-review-uat.yml',
  '.github/workflows/code-review-main.yml'
];

let allFilesExist = true;
requiredFiles.forEach(file => {
  const exists = fs.existsSync(file);
  console.log(`   ${exists ? '✅' : '❌'} ${file}`);
  if (!exists) allFilesExist = false;
});

if (!allFilesExist) {
  console.log('\n❌ Some required files are missing!');
  process.exit(1);
}

// Test 2: Validate package.json
console.log('\n2. Validating package.json...');
try {
  const packageJson = JSON.parse(fs.readFileSync('code-review-tool/package.json', 'utf8'));
  const requiredDeps = ['@octokit/rest', 'openai', 'yaml', 'glob'];
  
  requiredDeps.forEach(dep => {
    const hasDep = packageJson.dependencies && packageJson.dependencies[dep];
    console.log(`   ${hasDep ? '✅' : '❌'} ${dep} dependency`);
  });
} catch (error) {
  console.log('   ❌ Invalid package.json:', error.message);
}

// Test 3: Validate configuration
console.log('\n3. Validating configuration...');
try {
  const configPath = path.join(process.cwd(), 'code-review-tool', 'config', 'review-criteria.yml');
  const configContent = fs.readFileSync(configPath, 'utf8');
  const config = yaml.parse(configContent);
  
  // Check required sections
  const requiredSections = ['global', 'branches', 'issue_labels', 'openai'];
  requiredSections.forEach(section => {
    const hasSection = config[section];
    console.log(`   ${hasSection ? '✅' : '❌'} ${section} section`);
  });
  
  // Check branch configurations
  const expectedBranches = ['development', 'uat', 'main'];
  expectedBranches.forEach(branch => {
    const hasBranch = config.branches && config.branches[branch];
    console.log(`   ${hasBranch ? '✅' : '❌'} ${branch} branch config`);
  });
  
} catch (error) {
  console.log('   ❌ Invalid configuration:', error.message);
}

// Test 4: Check workflow syntax
console.log('\n4. Validating workflow files...');
const workflowFiles = [
  '.github/workflows/code-review-development.yml',
  '.github/workflows/code-review-uat.yml',
  '.github/workflows/code-review-main.yml'
];

workflowFiles.forEach(file => {
  try {
    const content = fs.readFileSync(file, 'utf8');
    // Basic YAML validation
    yaml.parse(content);
    console.log(`   ✅ ${file} syntax valid`);
  } catch (error) {
    console.log(`   ❌ ${file} syntax error:`, error.message);
  }
});

// Test 5: Environment variables check
console.log('\n5. Environment variables check...');
const requiredEnvVars = [
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'GITHUB_REPOSITORY',
  'GITHUB_SHA',
  'BRANCH_NAME'
];

requiredEnvVars.forEach(envVar => {
  const hasVar = process.env[envVar];
  console.log(`   ${hasVar ? '✅' : '⚠️ '} ${envVar} ${hasVar ? 'is set' : 'not set (will be set by GitHub Actions)'}`);
});

console.log('\n🎉 Setup validation complete!');
console.log('\nNext steps:');
console.log('1. Add OPENAI_API_KEY to your repository secrets');
console.log('2. Push these files to your repository');
console.log('3. Test by pushing to development branch');
console.log('4. Check the Actions tab for workflow execution');
