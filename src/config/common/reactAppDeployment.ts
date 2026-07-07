import { Client } from "ssh2";
import { exec } from "child_process";
import fs from "fs";
import * as path from "path";

// Define SSH configuration type
interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKey: any;
}

// Function to create the build for the React application
const createBuild = (buildDir: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    exec(
      "npm run build",
      { cwd: path.dirname(buildDir) },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`Error creating build: ${stderr}`);
          return reject(error);
        }
        console.log(stdout);
        resolve();
      }
    );
  });
};

// Function to deploy React application
const deployReactApp = async (
  sshConfig: SSHConfig,
  localBuildDir: string,
  remoteDir: string
) => {
  return new Promise<void>((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        console.log("SSH Connection established.");

        conn.sftp((err: any, sftp: any) => {
          if (err) return reject(err);

          const uploadDir = (
            localDir: string,
            remoteDir: string
          ): Promise<void[]> => {
            return new Promise((uploadResolve, uploadReject) => {
              fs.readdir(localDir, (err, files) => {
                if (err) return uploadReject(err);

                const uploadPromises = files.map((file) => {
                  const localFilePath = path.join(localDir, file);
                  const remoteFilePath = `${remoteDir}/${file}`;

                  return new Promise<void>(
                    (fileResolve: any, fileReject: any) => {
                      fs.stat(localFilePath, (err, stat) => {
                        if (err) return fileReject(err);

                        if (stat.isDirectory()) {
                          sftp.mkdir(remoteFilePath, (err: any) => {
                            if (err && err.code !== 4) return fileReject(err);
                            uploadDir(localFilePath, remoteFilePath)
                              .then(fileResolve)
                              .catch(fileReject);
                          });
                        } else {
                          // Upload file
                          sftp.fastPut(
                            localFilePath,
                            remoteFilePath,
                            (err: any) => {
                              if (err) return fileReject(err);
                              fileResolve();
                            }
                          );
                        }
                      });
                    }
                  );
                });

                Promise.all(uploadPromises)
                  .then(uploadResolve)
                  .catch(uploadReject);
              });
            });
          };

          uploadDir(localBuildDir, remoteDir)
            .then(() => {
              sftp.readdir(remoteDir, (err: any, list: any) => {
                if (err) return reject(err);
                conn.end();
                resolve();
              });
            })
            .catch(reject);
        });
      })
      .connect(sshConfig);
  });
};

// Function to delete existing build directory if it exists
const deleteExistingBuild = (buildDir: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    fs.rm(buildDir, { recursive: true, force: true }, (err) => {
      if (err) {
        console.error(`Error deleting existing build directory: ${err}`);
        return reject(err);
      }
      resolve();
    });
  });
};

// SSH credentials and paths
const config: SSHConfig = {
  host: "154.41.233.141",
  port: 65002,
  username: "u260162515",
  privateKey: fs.readFileSync("C:\\Users\\lenov\\.ssh\\id_rsa"),
};

// Paths
const localBuildDir = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "empowerlyconnectFrontend",
  "build"
);

console.log(localBuildDir)

const remoteDir = "/home/u260162515/public_html";

// Deployment process
const deploy = async () => {
  try {
    // Step 1: Delete existing build if it exists
    await deleteExistingBuild(localBuildDir);

    // Step 2: Create a new build
    await createBuild(localBuildDir);

    // Step 3: Deploy the new build
    await deployReactApp(config, localBuildDir, remoteDir);
    console.log("Deployment successful!");
  } catch (err) {
    console.error("Deployment failed:", err);
  }
};

export default deploy
// Run the deployment
// deploy();
