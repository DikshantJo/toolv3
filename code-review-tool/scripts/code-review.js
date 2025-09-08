#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { glob } = require('glob');

class CodeReviewBot {
  constructor() {
    // Validate required environment variables
    this.validateEnvironment();
    
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    this.config = this.loadConfig();
    this.repository = process.env.GITHUB_REPOSITORY;
    this.sha = process.env.GITHUB_SHA;
    this.branchName = process.env.BRANCH_NAME;
    this.sourceBranch = process.env.SOURCE_BRANCH;
    
    // Performance tracking
    this.startTime = Date.now();
    this.metrics = {
      filesProcessed: 0,
      apiCalls: 0,
      openaiCalls: 0,
      totalTime: 0
    };
  }

  validateEnvironment() {
    const required = ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'BRANCH_NAME'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      console.error('Missing required environment variables:', missing.join(', '));
      process.exit(1);
    }
    
    // Security: Validate repository name format
    const repoName = process.env.GITHUB_REPOSITORY;
    if (!repoName || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoName)) {
      console.error('Invalid GITHUB_REPOSITORY format:', repoName);
      process.exit(1);
    }
    
    // Security: Validate SHA format (should be 40 character hex string)
    const sha = process.env.GITHUB_SHA;
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
      console.error('Invalid GITHUB_SHA format:', sha);
      process.exit(1);
    }
  }

  loadConfig() {
    try {
      const configPath = path.join(process.cwd(), 'config', 'review-criteria.yml');
      
      // Security: Validate that the config path is within the expected directory
      const resolvedPath = path.resolve(configPath);
      const expectedDir = path.resolve(process.cwd(), 'config');
      
      if (!resolvedPath.startsWith(expectedDir)) {
        throw new Error('Invalid configuration path detected');
      }
      
      const configContent = fs.readFileSync(configPath, 'utf8');
      return yaml.parse(configContent);
    } catch (error) {
      console.error('Error loading configuration:', error);
      process.exit(1);
    }
  }

  async getChangedFiles() {
    try {
      let baseSha;
      
      console.log(`🔍 Detecting file changes for commit: ${this.sha}`);
      console.log(`📋 Event type: ${process.env.GITHUB_EVENT_NAME}`);
      
      if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
        // For PRs, compare with base branch
        console.log(`🔗 Pull request #${process.env.GITHUB_EVENT_NUMBER}`);
        this.metrics.apiCalls++;
        const { data: pr } = await this.octokit.rest.pulls.get({
          owner: this.repository.split('/')[0],
          repo: this.repository.split('/')[1],
          pull_number: process.env.GITHUB_EVENT_NUMBER
        });
        baseSha = pr.base.sha;
        console.log(`📊 PR base: ${baseSha}, head: ${pr.head.sha}`);
      } else {
        // For pushes, compare with previous commit
        console.log(`📤 Push event - getting previous commit`);
        this.metrics.apiCalls++;
        const { data: commits } = await this.octokit.rest.repos.listCommits({
          owner: this.repository.split('/')[0],
          repo: this.repository.split('/')[1],
          sha: this.sha,
          per_page: 2
        });
        baseSha = commits[1]?.sha;
        console.log(`📊 Current: ${this.sha}, Previous: ${baseSha}`);
      }

      if (!baseSha) {
        console.log('⚠️  No base commit found - cannot determine changed files');
        console.log('This usually happens on the first commit of a repository');
        return [];
      }

      console.log(`🔄 Comparing commits: ${baseSha} → ${this.sha}`);
      this.metrics.apiCalls++;
      const { data: comparison } = await this.octokit.rest.repos.compareCommits({
        owner: this.repository.split('/')[0],
        repo: this.repository.split('/')[1],
        base: baseSha,
        head: this.sha
      });

      const files = comparison.files || [];
      console.log(`📁 Found ${files.length} changed files:`);
      files.forEach(file => {
        console.log(`   ${file.status}: ${file.filename}`);
      });

      return files;
    } catch (error) {
      console.error('❌ Error getting changed files:', error);
      console.error('This could be due to:');
      console.error('   - Invalid repository or commit SHA');
      console.error('   - Insufficient GitHub API permissions');
      console.error('   - Network connectivity issues');
      console.error('   - Repository access restrictions');
      throw error; // Don't fallback to analyzing all files - this is dangerous
    }
  }



  shouldIncludeFile(filename) {
    const excludePatterns = this.config.global.exclude_patterns;
    const includeExtensions = this.config.global.include_extensions;
    
    // Check exclude patterns
    for (const pattern of excludePatterns) {
      if (this.matchesPattern(filename, pattern)) {
        return false;
      }
    }
    
    // Check include extensions
    return includeExtensions.some(ext => 
      filename.toLowerCase().endsWith(ext.toLowerCase())
    );
  }

  filterFiles(files) {
    const excludePatterns = this.config.global.exclude_patterns;
    const includeExtensions = this.config.global.include_extensions;
    
    console.log(`🔍 Filtering ${files.length} files based on configuration:`);
    console.log(`   📝 Include extensions: ${includeExtensions.join(', ')}`);
    console.log(`   🚫 Exclude patterns: ${excludePatterns.length} patterns`);
    
    const filteredFiles = files.filter(file => {
      // Check exclude patterns
      for (const pattern of excludePatterns) {
        if (this.matchesPattern(file.filename, pattern)) {
          console.log(`   ❌ Excluded ${file.filename} (matches pattern: ${pattern})`);
          return false;
        }
      }
      
      // Check include extensions
      const hasValidExtension = includeExtensions.some(ext => 
        file.filename.toLowerCase().endsWith(ext.toLowerCase())
      );
      
      if (!hasValidExtension) {
        console.log(`   ❌ Excluded ${file.filename} (extension not in include list)`);
        return false;
      }
      
      console.log(`   ✅ Included ${file.filename}`);
      return true;
    });
    
    return filteredFiles;
  }

  matchesPattern(filename, pattern) {
    // Security: Validate pattern to prevent ReDoS attacks
    if (pattern.length > 1000) {
      console.warn(`Pattern too long, skipping: ${pattern.substring(0, 50)}...`);
      return false;
    }
    
    // Security: Prevent complex regex patterns that could cause ReDoS
    if (pattern.includes('**') && pattern.split('**').length > 10) {
      console.warn(`Pattern too complex, skipping: ${pattern}`);
      return false;
    }
    
    try {
      // Simple glob pattern matching using string methods
      // This is more reliable than regex conversion
      
      // Handle ** patterns
      if (pattern.includes('**')) {
        // Handle specific common patterns
        if (pattern === '**/node_modules/**') {
          return filename.includes('/node_modules/') || filename.startsWith('node_modules/');
        }
        if (pattern === '**/*.js') {
          return filename.endsWith('.js');
        }
        if (pattern === '**/*.env*') {
          return filename.includes('.env');
        }
        if (pattern === '**/*.key') {
          return filename.endsWith('.key');
        }
        if (pattern === '**/*.pem') {
          return filename.endsWith('.pem');
        }
        if (pattern === '**/*.p12') {
          return filename.endsWith('.p12');
        }
        if (pattern === '**/*.pfx') {
          return filename.endsWith('.pfx');
        }
        if (pattern === '**/credentials*') {
          return filename.includes('credentials');
        }
        if (pattern === '**/secrets*') {
          return filename.includes('secrets');
        }
        if (pattern === '**/*.db') {
          return filename.endsWith('.db');
        }
        if (pattern === '**/*.sqlite') {
          return filename.endsWith('.sqlite');
        }
        if (pattern === '**/*.sqlite3') {
          return filename.endsWith('.sqlite3');
        }
        if (pattern === '**/database*') {
          return filename.includes('database');
        }
        if (pattern === '**/db/*') {
          return filename.startsWith('db/');
        }
        if (pattern === '**/migrations/*') {
          return filename.startsWith('migrations/');
        }
        if (pattern === '**/dist/**') {
          return filename.includes('/dist/') || filename.startsWith('dist/');
        }
        if (pattern === '**/build/**') {
          return filename.includes('/build/') || filename.startsWith('build/');
        }
        if (pattern === '**/.git/**') {
          return filename.includes('/.git/') || filename.startsWith('.git/');
        }
        
        // Generic ** pattern handling
        const parts = pattern.split('**');
        if (parts.length === 2) {
          const prefix = parts[0];
          const suffix = parts[1];
          
          if (prefix === '' && suffix === '') {
            return true; // Pattern is just "**"
          } else if (prefix === '') {
            return filename.endsWith(suffix);
          } else if (suffix === '') {
            return filename.startsWith(prefix);
          } else {
            return filename.includes(prefix + suffix);
          }
        }
      }
      
      // Handle simple * patterns
      if (pattern.includes('*') && !pattern.includes('**')) {
        // Convert to regex for simple wildcards
        let regexPattern = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*');
        
        regexPattern = '^' + regexPattern + '$';
        const regex = new RegExp(regexPattern);
        return regex.test(filename);
      }
      
      // Exact match
      return filename === pattern;
      
    } catch (error) {
      console.warn(`Invalid pattern, skipping: ${pattern}`);
      return false;
    }
  }

  parseTextResponse(responseContent, filename) {
    // Fallback method to parse text responses when JSON parsing fails
    const issues = [];
    let severity = 'low';
    
    try {
      // Look for severity indicators in the text
      if (responseContent.toLowerCase().includes('high severity') || 
          responseContent.toLowerCase().includes('critical')) {
        severity = 'high';
      } else if (responseContent.toLowerCase().includes('medium severity') || 
                 responseContent.toLowerCase().includes('moderate')) {
        severity = 'medium';
      }
      
      // Extract issues from text using simple pattern matching
      const issuePatterns = [
        /"description":\s*"([^"]+)"/g,
        /"severity":\s*"([^"]+)"/g,
        /"line":\s*"([^"]+)"/g,
        /"recommendation":\s*"([^"]+)"/g
      ];
      
      // Try to extract structured information
      const descriptions = [...responseContent.matchAll(/"description":\s*"([^"]+)"/g)];
      const severities = [...responseContent.matchAll(/"severity":\s*"([^"]+)"/g)];
      const lines = [...responseContent.matchAll(/"line":\s*"([^"]+)"/g)];
      const recommendations = [...responseContent.matchAll(/"recommendation":\s*"([^"]+)"/g)];
      
      // Create issues from extracted data
      const maxIssues = Math.max(descriptions.length, severities.length, lines.length, recommendations.length);
      
      for (let i = 0; i < maxIssues; i++) {
        const issue = {
          description: descriptions[i] ? descriptions[i][1] : 'Issue found in code',
          severity: severities[i] ? severities[i][1] : 'medium',
          line: lines[i] ? lines[i][1] : 'unknown',
          recommendation: recommendations[i] ? recommendations[i][1] : 'Review the code for potential issues'
        };
        issues.push(issue);
      }
      
      // If no structured data found, create a generic issue
      if (issues.length === 0 && responseContent.length > 100) {
        issues.push({
          description: 'Code analysis completed with findings',
          severity: 'medium',
          line: 'various',
          recommendation: 'Review the OpenAI response for detailed analysis'
        });
      }
      
    } catch (error) {
      console.error('Error in fallback parsing:', error);
    }
    
    return { issues, severity };
  }

  async getFileContent(filename) {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.repository.split('/')[0],
        repo: this.repository.split('/')[1],
        path: filename,
        ref: this.sha
      });
      
      if (data.type === 'file') {
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        
        // Limit file size to prevent OpenAI API issues (50KB limit)
        const maxSize = 50 * 1024; // 50KB
        if (content.length > maxSize) {
          console.log(`File ${filename} is too large (${content.length} bytes), truncating to ${maxSize} bytes`);
          return content.substring(0, maxSize) + '\n... (truncated due to size)';
        }
        
        return content;
      }
      return null;
    } catch (error) {
      console.error(`Error getting content for ${filename}:`, error);
      return null;
    }
  }

  async reviewCode(files) {
    const branchConfig = this.config.branches[this.branchName.toLowerCase()];
    if (!branchConfig) {
      console.log(`No configuration found for branch: ${this.branchName}`);
      console.log(`Available branches: ${Object.keys(this.config.branches).join(', ')}`);
      return [];
    }

    console.log(`🔄 Processing ${files.length} files in parallel...`);
    
    // Process files in parallel with concurrency limit
    const concurrencyLimit = this.config.performance?.concurrency_limit || 3;
    const issues = [];
    
    for (let i = 0; i < files.length; i += concurrencyLimit) {
      const batch = files.slice(i, i + concurrencyLimit);
      console.log(`📦 Processing batch ${Math.floor(i / concurrencyLimit) + 1}/${Math.ceil(files.length / concurrencyLimit)} (${batch.length} files)`);
      
      const batchPromises = batch.map(file => this.processFile(file, branchConfig));
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          issues.push(result.value);
        } else if (result.status === 'rejected') {
          console.error(`Error processing ${batch[index].filename}:`, result.reason);
        }
      });
    }
    
    return issues;
  }

  async processFile(file, branchConfig) {
    try {
      let content = '';
      
      // For GitHub API files, use patch if available, otherwise get full content
      if (file.patch) {
        content = file.patch;
      } else if (file.filename) {
        content = await this.getFileContent(file.filename);
      }
      
      if (!content) {
        console.log(`⏭️  Skipping ${file.filename}: no content available`);
        return null;
      }

      // Limit content size for OpenAI API
      const maxContentLength = this.config.performance?.max_file_size || 3000;
      if (content.length > maxContentLength) {
        content = content.substring(0, maxContentLength) + '\n... (truncated)';
      }

      const reviewResult = await this.analyzeWithOpenAI(content, file.filename, branchConfig);
      this.metrics.filesProcessed++;
      
      if (reviewResult.issues && reviewResult.issues.length > 0) {
        return {
          file: file.filename,
          issues: reviewResult.issues,
          severity: reviewResult.severity
        };
      }
      
      return null;
    } catch (error) {
      console.error(`❌ Error reviewing ${file.filename}:`, error);
      return null;
    }
  }

  async analyzeWithOpenAI(content, filename, branchConfig) {
    try {
      console.log(`🤖 Analyzing ${filename} with OpenAI...`);
      console.log(`📏 Content length: ${content.length} characters`);
      
      const criteria = branchConfig.review_criteria;
      const criteriaText = Object.entries(criteria)
        .map(([category, items]) => `${category.toUpperCase()}:\n${items.map(item => `- ${item}`).join('\n')}`)
        .join('\n\n');

      const prompt = `${this.config.openai.system_prompt}

REVIEW CRITERIA:
${criteriaText}

FILE: ${filename}
CODE TO REVIEW:
\`\`\`
${content}
\`\`\`

Please analyze this code and provide:
1. A list of issues found (if any)
2. Severity level for each issue (high/medium/low)
3. Specific recommendations for fixes

Format your response as JSON:
{
  "issues": [
    {
      "description": "Issue description",
      "severity": "high|medium|low",
      "line": "line number or range",
      "recommendation": "How to fix this issue"
    }
  ],
  "severity": "overall severity (highest found)"
}`;

      console.log(`📤 Sending request to OpenAI (${this.config.openai.model})...`);
      console.log(`📏 Prompt length: ${prompt.length} characters`);
      this.metrics.openaiCalls++;
      const openaiStartTime = Date.now();
      
      const response = await this.openai.chat.completions.create({
        model: this.config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: this.config.openai.max_tokens,
        temperature: this.config.openai.temperature
      });
      
      const openaiTime = Date.now() - openaiStartTime;
      console.log(`📥 Received response from OpenAI (${openaiTime}ms)`);
      console.log(`📄 Response length: ${response.choices[0].message.content.length} characters`);

      const responseContent = response.choices[0].message.content;
      if (!responseContent) {
        console.error('Empty response from OpenAI');
        return { issues: [], severity: 'low' };
      }
      
      try {
        // Extract JSON from response (handle cases where OpenAI includes explanatory text)
        let jsonContent = responseContent.trim();
        
        // Look for JSON block in the response
        const jsonMatch = jsonContent.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          jsonContent = jsonMatch[1];
        } else {
          // Look for JSON object starting with {
          const jsonStart = jsonContent.indexOf('{');
          if (jsonStart !== -1) {
            jsonContent = jsonContent.substring(jsonStart);
          }
        }
        
        const result = JSON.parse(jsonContent);
        console.log(`✅ Analysis complete for ${filename}:`);
        console.log(`   📊 Found ${result.issues ? result.issues.length : 0} issues`);
        console.log(`   🚨 Overall severity: ${result.severity || 'low'}`);
        if (result.issues && result.issues.length > 0) {
          result.issues.forEach((issue, index) => {
            console.log(`   ${index + 1}. [${issue.severity.toUpperCase()}] ${issue.description}`);
          });
        }
        return result;
      } catch (parseError) {
        console.error('❌ Failed to parse OpenAI response as JSON:', parseError);
        console.error('Raw response:', responseContent);
        
        // Fallback: try to extract issues from text response
        try {
          const fallbackResult = this.parseTextResponse(responseContent, filename);
          if (fallbackResult.issues.length > 0) {
            console.log(`✅ Fallback parsing successful for ${filename}:`);
            console.log(`   📊 Found ${fallbackResult.issues.length} issues`);
            console.log(`   🚨 Overall severity: ${fallbackResult.severity}`);
            return fallbackResult;
          }
        } catch (fallbackError) {
          console.error('❌ Fallback parsing also failed:', fallbackError);
        }
        
        return { issues: [], severity: 'low' };
      }
    } catch (error) {
      console.error('Error analyzing with OpenAI:', error);
      if (error.status === 401) {
        console.error('OpenAI API key is invalid or expired');
      } else if (error.status === 429) {
        console.error('OpenAI API rate limit exceeded');
      } else if (error.status === 500) {
        console.error('OpenAI API server error');
      }
      return { issues: [], severity: 'low' };
    }
  }

  async createGitHubIssue(fileIssues, severity) {
    const branchConfig = this.config.branches[this.branchName.toLowerCase()];
    if (!branchConfig) {
      console.log('No branch configuration found, skipping issue creation');
      return;
    }
    
    const severityThreshold = branchConfig.severity_threshold;
    
    // Check if severity meets threshold
    const severityLevels = { low: 1, medium: 2, high: 3 };
    if (severityLevels[severity] < severityLevels[severityThreshold]) {
      console.log(`Severity ${severity} below threshold ${severityThreshold}, skipping issue creation`);
      return;
    }

    const label = this.config.issue_labels[severity];
    const title = `Code Review Issues - ${severity.toUpperCase()} Severity`;
    
    let body = `## Code Review Results\n\n`;
    body += `**Branch:** ${this.branchName}\n`;
    body += `**Source Branch:** ${this.sourceBranch}\n`;
    body += `**Commit:** ${this.sha}\n`;
    body += `**Severity:** ${severity.toUpperCase()}\n\n`;
    
    body += `### Issues Found:\n\n`;
    
    for (const fileIssue of fileIssues) {
      body += `#### 📁 ${fileIssue.file}\n\n`;
      
      for (const issue of fileIssue.issues) {
        body += `**${issue.severity.toUpperCase()}** - ${issue.description}\n`;
        if (issue.line) body += `*Line: ${issue.line}*\n`;
        if (issue.recommendation) body += `*Recommendation: ${issue.recommendation}*\n`;
        body += `\n`;
      }
    }
    
    body += `---\n`;
    body += `*This issue was automatically created by the Code Review Bot*`;

    try {
      const { data: issue } = await this.octokit.rest.issues.create({
        owner: this.repository.split('/')[0],
        repo: this.repository.split('/')[1],
        title: title,
        body: body,
        labels: [label.name]
      });

      console.log(`✅ Created issue #${issue.number}: ${title}`);
      return issue;
    } catch (error) {
      console.error('❌ Error creating GitHub issue:', error.message);
      
      if (error.status === 403) {
        console.error('🔒 Permission denied. This usually means:');
        console.error('   1. The GITHUB_TOKEN doesn\'t have "issues: write" permission');
        console.error('   2. The workflow needs explicit permissions in the YAML file');
        console.error('   3. The repository settings restrict issue creation');
        console.error('');
        console.error('💡 Solution: Add this to your workflow file:');
        console.error('   permissions:');
        console.error('     contents: read');
        console.error('     issues: write');
        console.error('     pull-requests: read');
      } else if (error.status === 404) {
        console.error('🔍 Repository not found. Check the repository name and permissions.');
      } else if (error.status === 422) {
        console.error('📝 Invalid issue data. Check the issue title and body format.');
      } else {
        console.error(`🚨 Unexpected error (${error.status}): ${error.message}`);
      }
      
      // Don't exit on issue creation failure - just log the error
      console.log('⚠️  Continuing without creating issue...');
    }
  }

  async run() {
    console.log(`Starting code review for branch: ${this.branchName}`);
    console.log(`Source branch: ${this.sourceBranch}`);
    
    const changedFiles = await this.getChangedFiles();
    console.log(`Found ${changedFiles.length} changed files`);
    
    const filteredFiles = this.filterFiles(changedFiles);
    console.log(`After filtering: ${filteredFiles.length} files to review`);
    
    if (filteredFiles.length === 0) {
      console.log('⚠️  No changed files detected. This might happen if:');
      console.log('   - Files were moved/renamed');
      console.log('   - Only configuration files changed');
      console.log('   - Only non-reviewable file types were changed (e.g., .txt, .md, .json)');
      console.log('   - Diff detection failed');
      console.log('✅ No code review needed - no reviewable files were changed');
      return;
    }
    
    const reviewResults = await this.reviewCode(filteredFiles);
    await this.handleReviewResults(reviewResults);
  }

  async handleReviewResults(reviewResults) {
    console.log(`📊 Review completed. Found issues in ${reviewResults.length} files`);
    
    if (reviewResults.length > 0) {
      // Determine overall severity
      const severities = reviewResults.flatMap(r => r.issues.map(i => i.severity));
      const severityLevels = { low: 1, medium: 2, high: 3 };
      const maxSeverity = severities.reduce((max, severity) => 
        severityLevels[severity] > severityLevels[max] ? severity : max, 'low'
      );
      
      console.log(`🚨 Overall severity: ${maxSeverity.toUpperCase()}`);
      console.log(`📝 Creating GitHub issue...`);
      
      const issue = await this.createGitHubIssue(reviewResults, maxSeverity);
      
      // Check if we should block
      const branchConfig = this.config.branches[this.branchName.toLowerCase()];
      if (branchConfig && branchConfig.blocking && maxSeverity === 'high') {
        console.log('🛑 BLOCKING: High severity issues found in main branch');
        process.exit(1);
      } else {
        console.log('✅ Code review completed - no blocking issues');
      }
    } else {
      console.log('✅ No issues found - code review passed!');
    }
    
    this.printPerformanceSummary();
    console.log('🎉 Code review completed successfully');
  }

  printPerformanceSummary() {
    const totalTime = Date.now() - this.startTime;
    this.metrics.totalTime = totalTime;
    
    console.log('\n📊 Performance Summary:');
    console.log(`   ⏱️  Total execution time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
    console.log(`   📁 Files processed: ${this.metrics.filesProcessed}`);
    console.log(`   🔗 GitHub API calls: ${this.metrics.apiCalls}`);
    console.log(`   🤖 OpenAI API calls: ${this.metrics.openaiCalls}`);
    
    if (this.metrics.filesProcessed > 0) {
      const avgTimePerFile = totalTime / this.metrics.filesProcessed;
      console.log(`   📈 Average time per file: ${avgTimePerFile.toFixed(0)}ms`);
    }
    
    if (this.metrics.openaiCalls > 0) {
      const avgOpenaiTime = totalTime / this.metrics.openaiCalls;
      console.log(`   🧠 Average OpenAI response time: ${avgOpenaiTime.toFixed(0)}ms`);
    }
    
    // Performance recommendations
    if (totalTime > 30000) { // 30 seconds
      console.log('\n💡 Performance Tips:');
      console.log('   - Consider reducing the number of files analyzed');
      console.log('   - Check if file size limits are appropriate');
      console.log('   - Monitor OpenAI API response times');
    }
  }
}

// Main execution
if (require.main === module) {
  const branchName = process.argv[2];
  if (!branchName) {
    console.error('Please provide branch name as argument');
    process.exit(1);
  }
  
  const bot = new CodeReviewBot();
  bot.run().catch(error => {
    console.error('Code review failed:', error);
    process.exit(1);
  });
}

module.exports = CodeReviewBot;
