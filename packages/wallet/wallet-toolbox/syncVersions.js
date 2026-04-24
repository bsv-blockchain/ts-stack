const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
      
      if (fs.existsSync(fullPath)) {
        const packageData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const oldVersion = packageData.version;
        
        packageData.version = version;
        fs.writeFileSync(fullPath, JSON.stringify(packageData, null, 2) + '\n');
        
        console.log(`Updated ${packagePath}: ${oldVersion} → ${version}`);
        
        // Run npm install to update package-lock.json
        if (fs.existsSync(fullDirPath)) {
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
          console.warn(`Warning: Directory ${dir} not found`);
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
