/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/ZipUtils.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const { Devices } = Cu.import("resource://gre/modules/devtools/Devices.jsm");
const { OS } = Cu.import("resource://gre/modules/osfile.jsm", {});

XPCOMUtils.defineLazyGetter(this, "cpmm", function() {
  return Cc["@mozilla.org/childprocessmessagemanager;1"]
           .getService(Ci.nsIMessageSender);
});

const kBlobFree       = "blobfree.zip";
const kBlobsInject    = "blobs-toinject.txt";
const kCmdlineFs      = "cmdline-fs.txt";
const kDeviceRecovery = "recovery.fstab";
const kDevicesJson    = "devices.json";

const kContent     = "content";
const kBlobs       = "blobs";
const kImages      = "images";

const kExpectedBlobFreeContent = [
  kBlobFree, kBlobsInject, kCmdlineFs, kDevicesJson, kDeviceRecovery
];

const kB2GInstallerTmp = FileUtils.getDir("TmpD", ["b2g-installer"], true).path;

let supportedDevices = [];

/**
 * This will get all blobs from a given device, storing inside a root
 * and provided a blob map.
 **/
function getBlobs(device, root, map) {
  console.debug("Pulling blobs ...");
  if (!device || !device.type === "adb") {
    console.error("Device", device, "is not valid");
    return Promise.reject("notready");
  }

  updateProgressValue(0, 1, "Preparing to get blobs from device");

  let blobsDir = new FileUtils.File(OS.Path.join(root, kBlobs));
  if (!blobsDir.exists()) {
    blobsDir.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("0700", 8));
  }

  let list = [];
  map.forEach(line => {
    if (line.indexOf(":") === -1) {
      return;
    }

    let [ src, tgt ] = line.split(":");
    if (!src || !tgt) {
      console.debug("Invalid source", src, "or target", tgt, "for", line);
      return;
    }

    // Element already in list
    if (list.indexOf(src) !== -1) {
      return;
    }

    // Remove leading / for OS.Path.join()
    let _src = src[0] === "/" ? src.slice(1) : src;

    let f = new FileUtils.File(OS.Path.join(blobsDir.path, _src));
    let p = f.parent;
    if (!p.exists()) {
      p.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("0700", 8));
    }

    if (!f.exists()) {
      list.push(src);
    }
  });

  return new Promise((resolve, reject) => {
    device.isRoot().then(isRoot => {
      if (!isRoot) {
        console.error("Not root, should not happen.");
      } else {
        console.debug("Ready to pull blobs from device.");
      }

      let currentBlob = 0;
      let pullNextBlob = function(cb) {
        if (currentBlob >= list.length) {
          cb && cb();
          return;
        }

        let src = list[currentBlob];
        if (!src) {
          console.error("Invalid", src, "at", currentBlob);
          return;
        }

        updateProgressValue(currentBlob, list.length, src);

        // Remove leading / for OS.Path.join()
        let _src = src[0] === "/" ? src.slice(1) : src;
        let f = new FileUtils.File(OS.Path.join(blobsDir.path, _src));
        currentBlob++;

        device.pull(src, f.path).then(res => {
          console.debug("adb pull", src, f.path, "success", res);
          pullNextBlob(cb);
        }).catch(reason => {
          console.error("adb pull", src, f.path, "fail", reason);
          pullNextBlob(cb);
        });
      };

      updateProgressValue(0, 1, "Starting to pull blobs from device.");
      pullNextBlob(function() {
        updateProgressValue(0, 1, "All blobs have been pulled.");
        resolve();
      });
    }).catch(reason => {
      console.error("isRoot():", reason);
      reject();
    });
  });
}

/**
 * Building a ramdisk (CPIO gzip'd)
 **/
function buildRamdisk(from, to) {
  let ramdiskDir = new FileUtils.File(OS.Path.join(from, "RAMDISK"));
  if (!ramdiskDir.exists() || !ramdiskDir.isDirectory()) {
    return Promise.reject();
  }

  console.debug("Building ramdisk", ramdiskDir.path, to);

  let options = {
    from: ramdiskDir.path,
    to: to
  };

  return new Promise((resolve, reject) => {
    cpmm.addMessageListener("B2GInstaller:MainProcess:BuildRamdisk:Return",
      function ramdiskMessageListener(reply) {
        cpmm.removeMessageListener("B2GInstaller:MainProcess:BuildRamdisk:Return", ramdiskMessageListener);
        console.debug("Received main process reply:", reply);

        if (reply.data.res) {
          resolve(true);
        } else {
          reject(false);
        }
      });

    cpmm.sendAsyncMessage("B2GInstaller:MainProcess:BuildRamdisk", options);
  });
}

/**
 * Building an Android bootable image, consisting of a kernel and a ramdisk
 **/
function buildBootable(root, to) {
  console.debug("Building bootable image", root, to);

  let readFiles = [];
  let filesToRead = [ "cmdline", "pagesize", "base" ];
  filesToRead.forEach(file => {
    readFiles.push(OS.File.read(OS.Path.join(root, file), { encoding: "utf-8" }));
  });

  let kernelFile  = new FileUtils.File(OS.Path.join(root, "kernel"));
  let ramdiskFile = new FileUtils.File(OS.Path.join(root, "initrd.img"));

  // it's in device/, not in device/content/(BOOT|RECOVERY)/
  let deviceTree = new FileUtils.File(OS.Path.join(root, "..", "..", "dt.img"));
  console.debug("This device hasDeviceTree? ", deviceTree.exists());

  return new Promise((resolve, reject) => {
    Promise.all(readFiles).then(results => {

      let options = {
        kernel:  kernelFile.path,
        ramdisk: ramdiskFile.path,
        dt:      deviceTree.path,
        output:  to
      };

      for (let i = 0; i < results.length; i++) {
        let filename = filesToRead[i];
        options[filename] = results[i].trim();
      };

      console.debug("Prepared options", options);

      cpmm.addMessageListener("B2GInstaller:MainProcess:BuildBootable:Return",
        function ramdiskMessageListener(reply) {
          cpmm.removeMessageListener("B2GInstaller:MainProcess:BuildBootable:Return", ramdiskMessageListener);
          console.debug("Received main process reply:", reply);

          if (reply.data.res) {
            resolve(true);
          } else {
            reject(false);
          }
        });

      cpmm.sendAsyncMessage("B2GInstaller:MainProcess:BuildBootable", options);
    }).catch(reason => {
      console.error("Reading all bootimg files", reason);
      reject(false);
    });
  });
}

/**
 * Helper to build boot.img
 **/
function buildBootImg(fstab) {
  let fstabPart = fstab["boot.img"];

  return new Promise((resolve, reject) => {
    buildRamdisk(fstabPart.sourceDir, OS.Path.join(fstabPart.sourceDir, "initrd.img")).then(result => {
      console.debug("Boot.img ramdisk built", result);

      buildBootable(fstabPart.sourceDir, fstabPart.imageFile).then(result => {
        console.debug("Built everything", result);
        resolve(true);
      }).catch(reason => {
        console.error("buildBootImg", reason);
        reject(false);
      });
    }).catch(reason => {
      console.error("buildRamdisk", reason);
      reject(false);
    });
  });
}

/**
 * Helper to build recovery.img
 **/
function buildRecoveryImg(fstab) {
  let fstabPart = fstab["recovery.img"];

  return new Promise((resolve, reject) => {
    buildRamdisk(fstabPart.sourceDir, OS.Path.join(fstabPart.sourceDir, "initrd.img")).then(result => {
      console.debug("Recovery.img ramdisk built", result);

      buildBootable(fstabPart.sourceDir, fstabPart.imageFile).then(result => {
        console.debug("Built everything", result);
        resolve(true);
      }).catch(reason => {
        console.error("buildBootImg", reason);
        reject(false);
      });
    }).catch(reason => {
      console.error("buildRamdisk", reason);
      reject(false);
    });
  });
}

/**
 * Building the main filesystem partition image
 **/
function buildSystemImg(fstab) {
  let fstabPart = fstab["system.img"];
  console.debug("Will build system.img from", fstabPart.sourceDir, "to", fstabPart.imageFile);

  // it's in device/, not in device/content/SYSTEM/
  let cmdline = new File(OS.Path.join(fstabPart.sourceDir, "..", "..", kCmdlineFs));

  return new Promise((resolve, reject) => {
    let fr = new FileReader();
    fr.readAsText(cmdline);
    console.debug("Reading content of", cmdline);
    fr.addEventListener("loadend", function() {
      let args = "";

      console.debug("Checking within", fr.result);
      let lines = fr.result.split("\n");
      console.debug("All lines", lines);
      lines.forEach(line => {
        if (line.startsWith("system.img")) {
          args = line.split(": ")[1];
          return;
        }
      });
      let options = {
        image: fstabPart.imageFile,
        source: fstabPart.sourceDir,
        cmdline_fs: args
      };

      console.debug("Sending message to main process");
      cpmm.addMessageListener("B2GInstaller:MainProcess:BuildExt4FS:Return",
        function ramdiskMessageListener(reply) {
          cpmm.removeMessageListener("B2GInstaller:MainProcess:BuildExt4FS:Return", ramdiskMessageListener);
          console.debug("Received main process reply:", reply);

          if (reply.data.res) {
            resolve(true);
          } else {
            reject(false);
          }
        });

      cpmm.sendAsyncMessage("B2GInstaller:MainProcess:BuildExt4FS", options);
    });
  });
}

/**
 * Building an empty userdata partition. Needed to flash this when coming from
 * Android, to avoid any leftover.
 **/
function buildDataImg(fstab) {
  let fstabPart = fstab["data.img"];
  console.debug("Will build data.img from", fstabPart.sourceDir, "to", fstabPart.imageFile);

  // it's in device/, not in device/content/DATA/
  let cmdline = new File(OS.Path.join(fstabPart.sourceDir, "..", "..", kCmdlineFs));

  return new Promise((resolve, reject) => {
    let fr = new FileReader();
    fr.readAsText(cmdline);
    console.debug("Reading content of", cmdline);
    fr.addEventListener("loadend", function() {
      let args = "";

      console.debug("Checking within", fr.result);
      let lines = fr.result.split("\n");
      console.debug("All lines", lines);
      lines.forEach(line => {
        if (line.startsWith("userdata.img")) {
          args = line.split(": ")[1];
          return;
        }
      });
      let options = {
        image: fstabPart.imageFile,
        source: fstabPart.sourceDir,
        cmdline_fs: args
      };

      console.debug("Sending message to main process");
      cpmm.addMessageListener("B2GInstaller:MainProcess:BuildExt4FS:Return",
        function ramdiskMessageListener(reply) {
          cpmm.removeMessageListener("B2GInstaller:MainProcess:BuildExt4FS:Return", ramdiskMessageListener);
          console.debug("Received main process reply:", reply);

          if (reply.data.res) {
            resolve(true);
          } else {
            reject(false);
          }
        });

      cpmm.sendAsyncMessage("B2GInstaller:MainProcess:BuildExt4FS", options);
    });
  });
}

/**
 * From a root directory and a blob map, we will copy the pulled blobs from
 * Android system into the expected path in the content directory.
 **/
function injectBlobs(root, map) {
  let list = [];

  map.forEach(line => {
    if (line.indexOf(":") === -1) {
      console.debug("Not a map line", line);
      return;
    }

    let [ src, tgt ] = line.split(":");
    if (!src || !tgt) {
      console.debug("Invalid source", src, "or target", tgt, "for", line);
      return;
    }

    // Remove leading / for OS.Path.join()
    let _src = src[0] === "/" ? src.slice(1) : src;
    let _tgt = tgt[0] === "/" ? tgt.slice(1) : tgt;

    let fileSrc = new FileUtils.File(OS.Path.join(root, kBlobs, _src));
    let fileTgt = new FileUtils.File(OS.Path.join(root, kContent, _tgt));

    if (!fileTgt.exists()) {
      console.debug("Copying", fileSrc.path, "to", fileTgt.path);
      try {
        fileSrc.copyTo(fileTgt.parent, fileTgt.leafName);
        list.push(tgt);
      } catch (ex) {
        console.error(fileSrc, fileTgt, ex);
        return;
      }
    }
  });

  return Promise.resolve(list);
}

/**
 * Reading the blob map file from a blobfree distribution
 **/
function readBlobsMap(root) {
  return new Promise((resolve, reject) => {
    let fr = new FileReader();
    let blobs = new File(OS.Path.join(root, kBlobsInject));
    fr.readAsText(blobs);
    console.debug("Reading blobs map from", blobs);
    fr.addEventListener("loadend", function() {
      console.debug("Blobs map:", fr.result.split("\n"));
      resolve(fr.result.split("\n"));
    });
  });
}

/**
 * Reading the recovery fstab file from a blobfree distribution
 **/
function readRecoveryFstab(root) {
  return new Promise((resolve, reject) => {
    let fr = new FileReader();
    let fstab = new File(OS.Path.join(root, kDeviceRecovery));
    fr.readAsText(fstab);
    console.debug("Reading fstab rom", fstab);
    fr.addEventListener("loadend", function() {
      let content = fr.result.split("\n");
      console.debug("Recovery fstab:", content);
      // resolve(fr.result.split("\n"));

      let finalFstab = {};
      content.forEach(line => {
        line = line.trim();

        if (!line.startsWith("/dev")) {
          return;
        }

        // device is 0, mount point is 1
        let parts = line.split(" ").filter(function(e) {
          return (e !== "");
        });

        let mountPoint   = parts[1].slice(1);
        let fastbootPart = parts[0].split("/").slice(-1)[0];
        let fastbootImg  = mountPoint + ".img";

        let contentDir = new FileUtils.File(OS.Path.join(root, kContent, mountPoint.toUpperCase()));
        if (!contentDir.exists() || !contentDir.isDirectory()) {
          console.debug("No", contentDir.path);
          return;
        }

        finalFstab[fastbootImg] = {
          "sourceDir": contentDir.path,
          "imageFile": OS.Path.join(root, kImages, fastbootImg),
          "partition": fastbootPart
        };
      });

      console.debug("Will use", finalFstab);
      resolve(finalFstab);
    });
  });
}

/**
 * Checking if a device is already running a B2G system (existence of
 * /system/b2g/b2g file).
 **/
function checkDeviceIsB2G(device) {
  return new Promise((resolve, reject) => {
    let target = "/system/b2g/b2g";
    device.shell("ls " + target).then(lsOutput => {
      console.debug("Read from fs:", lsOutput.trim());
      resolve(lsOutput.trim() === target);
    });
  });
}

/** Let's do everything:
  *  - First extract the blobfree distribution zip
  *  - make sure everything is here
  *  - extract the blobfree content package
  *  - compute blobs map
  *  - extract recovery fstab infos
  *  - make sure device is plugged in and supported
  *  - get all the needed blobs
  *  - copy them to the extracted content directory
  *  - build file system images
  *  - reboot device to fastboot mode and poll it
  *  - once detected, fastboot flash all partitions
  **/
function dealWithBlobFree(obj) {
  return new Promise((resolve, reject) => {
    console.log("Extracting blob free distribution:", obj.files[0]);

    let rootDirImage, blobsMap, deviceFstab, adbDevice, fastbootDevice, runsB2G;

    extractBlobFreeDistribution(obj.files[0]).then(root => {
      rootDirImage = root;

      console.log("Extracting blob free content:", rootDirImage);

      return extractBlobFreeContent(rootDirImage);
    }).then(result => {
      if (!result) {
        console.error("Error extracting content");
        return Promise.reject();
      }

      console.log("Blob free distribution extracted.");

      return readBlobsMap(rootDirImage);
    }).then(map => {
      blobsMap = map;

      console.log("Blob map extracted, getting fstab");

      return readRecoveryFstab(rootDirImage);
    }).then(fstab => {
      deviceFstab = fstab;

      console.log("Recovery fstab read", deviceFstab , ", enumerating devices");

      return getAllDevices(false);
    }).then(device => {
      adbDevice = device;

      console.log("Devices enumerating, forcing into root mode");

      return adbDevice.summonRoot();
    }).then(() => {
      console.log("Waiting for adb root to finish ...");

      // Avoid races conditions with adb root
      return new Promise((resolve, reject) => {
        console.debug("Starting 5 secs countdown ...");
        setTimeout(function() {
          console.debug("Finished 5 secs countdown  !");
          resolve();
        }, 5000);
      });
    }).then(() => {
      console.log("Device forced into root mode, checking B2G existence");

      return checkDeviceIsB2G(adbDevice);
    }).then(isB2G => {
      runsB2G = isB2G;

      console.log("B2G existence checked, pulling all blobs for", adbDevice);

      return getBlobs(adbDevice, rootDirImage, blobsMap);
    }).then(() => {
      console.log("Got blobs map", blobsMap, "injecting them");

      return injectBlobs(rootDirImage, blobsMap);
    }).then(injected => {
      console.log("Injected blobs", injected);

      let toBuild = [
        buildBootImg(deviceFstab),
        buildRecoveryImg(deviceFstab),
        buildSystemImg(deviceFstab)
      ];

      let keepMyB2GData = document.getElementById("keep-b2g-data").checked;

      console.debug("Does device runs B2G already?", runsB2G);
      console.debug("Does the users wants to keep data?", keepMyB2GData);

      // We need to flash the userdata partition if:
      // - we are coming from android
      // - the user asks to do so
      if (!runsB2G || (runsB2G && !keepMyB2GData)) {
        console.debug("Adding data partition to the build and flash list ...");
        toBuild.push(buildDataImg(deviceFstab));
      } else {
        console.debug("Removing data partition from build and flash list!");
        delete deviceFstab["data.img"];
      }

      return Promise.all(toBuild);
    }).then(results => {
      console.debug("All pending builds finished:", results);

      // Starting fastboot polling and rebooting device into
      // fastboot mode
      Devices.emit("fastboot-start-polling");

      return adbDevice.rebootBootloader();
    }).catch(reason => {
      console.error("rebootBootloader:", reason);
      reject();
    }).then(() => {
      console.debug("Device rebooting into in fastboot mode now.");

      // Avoid races conditions with adb reboot
      return new Promise((resolve, reject) => {
        console.debug("Starting 5 secs countdown ...");
        setTimeout(function() {
          console.debug("Finished 5 secs countdown  !");
          resolve();
        }, 5000);
      });
    }).then(() => {
      console.debug("Enumerating fastboot devices");

      return getAllDevices(false);
    }).then(fdevice => {
      fastbootDevice = fdevice;

      console.log("Devices enumerated, MUST be fastboot", fastbootDevice);

      if (!fastbootDevice.type === "fastboot") {
        console.error("We should have been into fastboot mode :(");
        reject();
      }

      Devices.emit("fastboot-stop-polling");

      return new Promise((resolve, reject) => {
        // Enumerating all fstab partitions we can flash
        // and doing the flash sequentially
        let list = Object.keys(deviceFstab);
        let currentImage = 0;
        let flashNextImage = function(cb) {
          if (currentImage >= list.length) {
            cb && cb();
            return;
          }

          let fstabEntry = deviceFstab[list[currentImage]];
          console.debug("Using", fstabEntry, "from", list[currentImage]);

          currentImage++;
          fastbootDevice.flash(fstabEntry.partition, fstabEntry.imageFile, fastbootDevice.id)
            .then(res => {
              console.debug("Flash for", fstabEntry, "returned", res);
              flashNextImage(cb);
            }).catch(reason => {
              flashNextImage(cb);
            });
        };

        flashNextImage(function() {
          console.log("All partitions should have been flashed now");
          resolve();
        });
      });
    }).catch(reason => {
      console.error("getAllDevices():", reason);
      reject();
    }).then(() => {
      console.log("Rebooting from Fastboot to System");

      // Everything should be good now, rebooting device!
      return fastbootDevice.reboot(fastbootDevice.id);
    }).then(() => {
      console.log("Device should be booting B2G now");
      resolve();
    });
  });
}

/**
 * Extracting the main zip file which is the blobfree distribution for a device.
 * That's the zip file containing the blobfree content (see below) and all the
 * needed files to check supported devices and how to rebuild and reflash.
 **/
function extractBlobFreeDistribution(zip) {
  console.debug("Dealing with", zip);

  // We expect file name to be like: PRODUCT_DEVICE.XXX.zip
  let fullPath = zip.mozFullPath;
  let productDevice = zip.name.split(".")[0];
  let devicePath = OS.Path.join(kB2GInstallerTmp, productDevice);

  let zipFile = new FileUtils.File(fullPath);
  let targetDir = new FileUtils.File(devicePath);

  if (!targetDir.exists()) {
     targetDir.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("0700", 8));
  } else {
     if (!targetDir.isDirectory()) {
       console.error("Target directory exists but is not a directory.");
       return Promise.reject();
     }
  }

  return new Promise((resolve, reject) => {
    ZipUtils.extractFilesAsync(zipFile, targetDir).then(result => {
      console.debug("Extracted", zipFile, "to", targetDir, "result=", result);
      for (let f of kExpectedBlobFreeContent) {
        let fi = new FileUtils.File(OS.Path.join(devicePath, f));
        console.debug("Checking existence of", f);
        if (!fi.exists()) {
          console.error("Missing", f);
          reject();
        }
      }

      let fr = new FileReader();
      let devices = new File(OS.Path.join(devicePath, kDevicesJson));
      fr.readAsText(devices);
      console.debug("Reading content of", devices);
      fr.addEventListener("loadend", function() {
        supportedDevices = JSON.parse(fr.result);
        console.debug("Content of devices:", supportedDevices);
        resolve(devicePath);
      });
    });
  });
}

/**
 * Extracting the device content of a blobfree distribution. That's the zip
 * file that contains all the prebuilt files we can redistribute.
 **/
function extractBlobFreeContent(devicePath) {
  let zipFile = new FileUtils.File(OS.Path.join(devicePath, kBlobFree));
  let targetDir = new FileUtils.File(OS.Path.join(devicePath, kContent));

  if (!targetDir.exists()) {
     targetDir.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("0700", 8));
  } else {
     if (!targetDir.isDirectory()) {
       console.error("Target directory exists but is not a directory.");
       return Promise.reject();
     }
  }

  let imagesDir = new FileUtils.File(OS.Path.join(devicePath, kImages));

  if (!imagesDir.exists()) {
     imagesDir.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("0700", 8));
  } else {
     if (!imagesDir.isDirectory()) {
       console.error("Target directory exists but is not a directory.");
       return Promise.reject();
     }
  }

  console.debug("Running ZipUtils.extractFiles");
  ZipUtils.extractFiles(zipFile, targetDir);
  console.debug("ZipUtils.extractFiles: success");

  return Promise.resolve(true);
}

function updateProgressValue(current, max, blobName) {
  let prcent  = ((current * 1.0) / max) * 100;
  document.getElementById("blobs-pulled").value = prcent;
  document.getElementById("current-blob").textContent = blobName;
}

function addNode(p, id, content) {
  let node = document.createElement("li");
  node.id = id;
  node.textContent = content || id;
  p.appendChild(node);
  return node;
}

function delNode(id) {
  let node = document.getElementById(id);
  if (!node) {
    return;
  }

  node.parentNode.removeChild(node);
}

function addAdbNode(id, name, cb) {
  let adbRoot = document.getElementById("adb-devices");
  let adbNode = addNode(adbRoot, id, name);
}

function delAdbNode(id) {
  delNode(id);
}

function addFastbootNode(id, product, cb) {
  let fastbootRoot = document.getElementById("fastboot-devices");
  let fastbootNode = addNode(fastbootRoot, id, product);
}

function delFastbootNode(id) {
  delNode(id);
}

function inAdbMode(device) {
  delFastbootNode(device.id);
  console.debug("[ADB] Device is in ADB mode.");

  device.isRoot().then(isRoot => {
    if (!isRoot) {
      console.debug("[ADB] Putting device into root mode.");
      device.summonRoot().then(() => {
        console.debug("[ADB] Device should be in root mode now.");
        getAllDevices();
      }).catch(reason => {
        console.error("summonRoot():", reason);
      });
    } else {
      device.getModel().then(model => {
        // Add the button to the UI with callback handler for rebooting the
        // device into fastboot mode
        addAdbNode(device.id, device.id + "/" + model);
      }).catch(reason => {
        console.error("getModel():", reason);
      });
    }
  }).catch(reason => {
    console.error("isRoot():", reason);
  });
}

function inFastbootMode(device) {
  delAdbNode(device.id);
  console.debug("[FASTBOOT] Device is in Fastboot mode.");
  device.getvar("product", device.id).then(product => {
    device.getvar("serialno", device.id).then(sn => {
      Devices.emit("fastboot-stop-polling");
      // Add the button to the UI with callback handler for rebooting the
      // device from fastboot to the system
      addFastbootNode(device.id, product + "/" + sn);
    });
  });
}

/**
 * Checking whether a device is supported or not. This works whether in ADB or
 * in Fastboot mode. In each case, we do rely on the content of the
 * supportedDevices array. In each mode we will read a set of variables and we
 * will cross check for each element in this array if we have full match.
 **/
function isSupportedDevice(device) {
  return new Promise((resolve, reject) => {
    // Get all ADB fields and check their values
    if (device.type === "adb") {
      let allAdbFields = {};
      device.shell("getprop").then(props => {
        for (let _line of props.split("\n")) {
          let line = _line.trim();
          if (line.length === 0) {
            continue;
          }

          let [ key, value ] = line.split(": ");
          if (key.slice(0, 1) === "[" && key.slice(-1) === "]") {
            key = key.slice(1, -1);
            if (value.slice(0, 1) === "[" && value.slice(-1) === "]") {
              value = value.slice(1, -1);
              allAdbFields[key] = value;
            }
          }
        }

        let deviceOk = false;
        for (let supportedDevice of supportedDevices) {

          let anyPropNotGood = false;
          for (let prop in supportedDevice.adb) {
            let values = supportedDevice.adb[prop];

            let propVal = allAdbFields[prop];
            let isOk = (typeof values === "object") ? (values.indexOf(propVal) !== -1) : (values === propVal);

            if (!isOk) {
              anyPropNotGood = true;
              break;
            }
          }

          if (!anyPropNotGood) {
            deviceOk = true;
            resolve(supportedDevice);
            break;
          }
        }

        if (!deviceOk) {
          reject();
        }
      }).catch(reason => {
        console.error("getprop:", reason);
        reject();
      });
    }

    // For fastboot, we query one by one
    if (device.type === "fastboot") {
      for (let supportedDevice of supportedDevices) {
        let getValues = [];

        for (let varname in supportedDevice.fastboot) {
          let values = supportedDevice.fastboot[varname];
          (function(name, expected) {
            let getValuePromise = device.getvar(name, device.id).then(function onSuccess(varVal) {
              let isOk = (typeof expected === "object") ? (expected.indexOf(varVal) !== -1) : (expected === varVal);
              return isOk;
            });
            getValues.push(getValuePromise);
          })(varname, values);
        }

        Promise.all(getValues).then(values => {
          if (values.indexOf(false) === -1) {
            resolve(supportedDevice);
          }
        })
      }
    }
  });
}

/**
 * Relying on Devices.jsm to enumerate all connected devices that have been
 * exposed by the ADBHelper addon. We check that we have supported device
 * and we check whether they are running in ADB or Fastboot mode.
 **/
function getAllDevices(triggerHandlers) {
  return new Promise((resolve, reject) => {
    let devices = Devices.available();
    for (let d in devices) {
      let name = devices[d];
      let device = Devices._devices[name];

      isSupportedDevice(device).then(() => {
        if (triggerHandlers) {
          if (device.type === "adb") {
            inAdbMode(device);
          }

          if (device.type === "fastboot") {
            inFastbootMode(device);
          }
        }

        resolve(device);
      }, () => {
        console.error("Device", device, "is not yet supported.");
        reject(device);
      });
    }
  });
}

addEventListener("load", function load() {
  removeEventListener("load", load, false);

  Devices.on("register", getAllDevices);
  Devices.on("unregister", getAllDevices);

  let blobsFreeImage = document.getElementById("blobfree");
  blobsFreeImage.addEventListener("change", dealWithBlobFree.bind(null, blobsFreeImage));
}, false);

/* vim: set et ts=2 sw=2 : */
