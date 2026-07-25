const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

function hasErrorCode(error, code) {
  return typeof error === 'object' && error !== null && error.code === code;
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    const completedDescriptor = descriptor;
    descriptor = undefined;
    fs.closeSync(completedDescriptor);
    fs.renameSync(temporary, file);
  } finally {
    try {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

/**
 * Synchronizes version numbers from root package.json to mobile and client package.json files
 * and updates package-lock.json files by running npm install
 */
function syncVersions() {
  try {
    // Read the root package.json
    const rootPackagePath = path.join(__dirname, 'package.json');
    const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
    const version = rootPackage.version;

    console.log(`Root package version: ${version}`);

    // Directories to update
    const directoriesToUpdate = [
      { packagePath: './mobile/package.json', dir: './mobile' },
      { packagePath: './client/package.json', dir: './client' }
    ];

    // Update each package.json file and run npm install
    directoriesToUpdate.forEach(({ packagePath, dir }) => {
      const fullPath = path.join(__dirname, packagePath);
      const fullDirPath = path.join(__dirname, dir);
      
      const packageData = readJsonIfExists(fullPath);
      if (packageData !== undefined) {
        const oldVersion = packageData.version;
        
        packageData.version = version;
        writeJsonAtomic(fullPath, packageData);
        
        console.log(`Updated ${packagePath}: ${oldVersion} → ${version}`);
        
        // Run npm install to update package-lock.json
        console.log(`Running npm install in ${dir}...`);
        try {
          execSync('npm install', {
            cwd: fullDirPath,
            stdio: 'inherit',
            timeout: 60000, // 60 second timeout
            env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }
          });
          console.log(`✓ npm install completed in ${dir}`);
        } catch (installError) {
          console.error(`✗ npm install failed in ${dir}:`, installError.message);
        }
      } else {
        console.warn(`Warning: ${packagePath} not found`);
      }
    });

    console.log('Version synchronization completed successfully!');
  } catch (error) {
    console.error('Error synchronizing versions:', error.message);
    process.exit(1);
  }
}

// Run the function if this script is executed directly
if (require.main === module) {
  syncVersions();
}

module.exports = syncVersions;
