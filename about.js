/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/ZipUtils.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// In Firefox 44 and later, many DevTools modules were relocated.
// See https://bugzil.la/912121
const { Devices } = Cu.import("resource://devtools/shared/apps/Devices.jsm");
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

const kAppIni    = "/system/b2g/application.ini"
const CONFIG_URL = 'https://raw.githubusercontent.com/mozilla-b2g/b2g-installer-builds/master/builds.json';

const kExpectedBlobFreeContent = [
  kBlobFree, kBlobsInject, kCmdlineFs, kDevicesJson, kDeviceRecovery
];

const kB2GInstallerTmp = FileUtils.getDir("TmpD", ["b2g-installer"], true).path;

let supportedDevices = [];
let $ = document.querySelectorAll.bind(document);

function xhr(url, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    let xhr = new XMLHttpRequest();

    let handler = ev => {
      evf(m => xhr.removeEventListener(m, handler, !1));

      if (xhr.status == 200) {
        return resolve(xhr.response);
      }
      reject(xhr);
    };

    let evf = f => ['load', 'error', 'abort'].forEach(f);
    evf(m => xhr.addEventListener(m, handler, false));

    if ('progress' in opts) {
      xhr.addEventListener('progress', opts.progress, false);
    }

    xhr.mozBackgroundRequest = true;
    xhr.open('GET', url, true);
    xhr.responseType = ('responseType' in opts) ? opts.responseType : 'json';
    xhr.send();
  });
}

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

  // Read cmdline_fs file for optional extra arguments
  let cmdline = new File(OS.Path.join(root, "..", "..", kCmdlineFs));

  return getCmdlineFsArgs(cmdline, OS.Path.basename(to)).then(args => {
    return new Promise((resolve, reject) => {
      Promise.all(readFiles).then(results => {

        let options = {
          kernel:  kernelFile.path,
          ramdisk: ramdiskFile.path,
          output:  to
        };

        if (args) {
          options.extraArguments = args;
        }

        if (deviceTree.exists()) {
          options.dt = deviceTree.path;
        }

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
  });
}

/**
 * Helper to build boot.img
 **/
function buildBootImg(fstab) {
  let fstabPart = fstab["boot.img"];
  downloadInfo('Building boot.img');

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
  downloadInfo('Building recovery.img');

  let imgSrc = OS.Path.join(fstabPart.sourceDir, "initrd.img");
  return buildRamdisk(fstabPart.sourceDir, imgSrc).then(result => {
    console.debug("Recovery.img ramdisk built", result);
    return buildBootable(fstabPart.sourceDir, fstabPart.imageFile);
  });
}

function getFileContexts(fstab) {
  let bootPart = fstab["boot.img"];
  let context = new FileUtils.File(OS.Path.join(bootPart.sourceDir, "RAMDISK", "file_contexts"));

  if (context.exists()) {
    return " -S " + context.path;
  } else {
    return null;
  }
}

/**
 * Building the main filesystem partition image
 **/
function buildSystemImg(fstab) {
  let fstabPart = fstab["system.img"];
  downloadInfo('Building system.img');
  console.debug("Will build system.img from",
                fstabPart.sourceDir, "to", fstabPart.imageFile);

  let context = getFileContexts(fstab);

  // it's in device/, not in device/content/SYSTEM/
  let cmdline = new File(OS.Path.join(fstabPart.sourceDir, "..", "..", kCmdlineFs));

  return getCmdlineFsArgs(cmdline, "system.img").then(args => {
    return new Promise((resolve, reject) => {
      if (context) {
        args += context;
      }

      let options = {
        image: fstabPart.imageFile,
        source: fstabPart.sourceDir,
        cmdline_fs: args
      };

      console.debug("Sending message to main process");
      cpmm.addMessageListener("B2GInstaller:MainProcess:BuildExt4FS:Return",
        function ramdiskMessageListener(reply) {
          cpmm.removeMessageListener("B2GInstaller:MainProcess:BuildExt4FS:Return",
                                     ramdiskMessageListener);
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
  downloadInfo('Building data.img');
  console.debug("Will build data.img from", fstabPart.sourceDir, "to", fstabPart.imageFile);

  // it's in device/, not in device/content/DATA/
  let cmdline = new File(OS.Path.join(fstabPart.sourceDir, "..", "..", kCmdlineFs));

  return getCmdlineFsArgs(cmdline, "userdata.img").then(args => {
    return new Promise((resolve, reject) => {
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
 * Read the cmdline_fs.txt file to get any extra arguments needed to build a
 * specific image
 * @param {String} cmdline - Path to the cmdline_fs.txt file
 * @param {String} imageName - Name of the image
 * @return {Promise<String>}
 */
function getCmdlineFsArgs(cmdline, imageName) {
  return new Promise(resolve => {
    let fr = new FileReader();
    fr.readAsText(cmdline);
    console.debug("Reading content of", cmdline);
    fr.addEventListener("loadend", () => {
      let args = "";
      console.debug("Checking within", fr.result);
      let lines = fr.result.split("\n");
      console.debug("All lines", lines);
      lines.forEach(line => {
        if (line.startsWith(imageName)) {
          args = line.split(":")[1].trim();
          return;
        }
      });
      resolve(args);
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

    if (fileSrc.exists() && !fileTgt.exists()) {
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
 * Reading the list of devices supported by this distribution
 **/
function readDevicesJson(root) {
  return new Promise((resolve, reject) => {
    let fr = new FileReader();
    let devices = new File(OS.Path.join(root, kDevicesJson));
    fr.readAsText(devices);
    console.debug("Reading content of", devices);
    fr.addEventListener("loadend", function() {
      console.debug("Content of devices:", fr.result);
      resolve(JSON.parse(fr.result));
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
 * /system/b2g/application.ini file).
 **/
function checkDeviceIsB2G(device) {
  return new Promise((resolve, reject) => {
    device.shell("ls " + kAppIni).then(lsOutput => {
      console.debug("Read from fs:", lsOutput.trim());
      resolve(lsOutput.trim() === kAppIni);
    });
  });
}

function appIniToObj(ini) {
  let obj = {};
  let section = null;

  ini.split("\n").forEach(line => {
    // A line with ";" is a comment
    if (line.startsWith(";")) {
      return;
    }

    // A line "[XXX]" is Section XXX
    let isSection = line.match(/\[(.*)\]/);
    if (isSection) {
      let sectionName = isSection[1];
      section = sectionName;
      obj[section] = {};
      return;
    }

    let isEntry = line.match(/(.*)=(.*)/);
    if (isEntry) {
      let entryName  = isEntry[1];
      let entryValue = isEntry[2];
      obj[section][entryName] = entryValue;
      return;
    }
  });

  console.debug("Final value", obj);
  return obj;
}

/**
 * Read the content of application.ini. We assume this is a B2G device. If not,
 * this will fail.
 **/
function readApplicationIni(device) {
  return new Promise((resolve, reject) => {
    device.shell("cat " + kAppIni).then(catOutput => {
      let content = catOutput.trim();
      console.debug("Read:", content);
      resolve(appIniToObj(content));
    });
  });
}


/**
 * Extracting the main zip file which is the blobfree distribution for a device.
 * That's the zip file containing the blobfree content (see below) and all the
 * needed files to check supported devices and how to rebuild and reflash.
 **/
function extractBlobFreeDistribution(path) {
  console.debug("Dealing with", path);

  // We expect file name to be like: PRODUCT_DEVICE.XXX.zip
  let productDevice = path.split('/').pop().split(".")[0];
  let devicePath = OS.Path.join(kB2GInstallerTmp, productDevice);

  let zipFile = new FileUtils.File(path);
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
    return ZipUtils.extractFilesAsync(zipFile, targetDir).then(result => {
      console.debug("Extracted", zipFile, "to", targetDir, "result=", result);
      for (let f of kExpectedBlobFreeContent) {
        let fi = new FileUtils.File(OS.Path.join(devicePath, f));
        console.debug("Checking existence of", f);
        if (!fi.exists()) {
          console.error("Missing", f);
          reject("missing:" + f);
          return;
        }
      }
      resolve(devicePath);
    }).catch(function(e) {
      // This can fail with permissions errors but is safe to ignore for now
      resolve();
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
  downloadInfo('Pulling: ' + blobName);
  subInfo(current + ' of ' + max + ' (' + percentStr(current, max) + ')');
}

function waitForAdb(device) {
  console.debug("[ADB] Device is in ADB mode. 2");
  return device.getModel();
}

function waitForFastboot(device) {
  console.debug("[FASTBOOT] Device is in Fastboot mode.");
  return device.getvar("product", device.id).then(product => {
    console.debug("[FASTBOOT] Device is in Fastboot mode, product=", product);
    return device.getvar("serialno", device.id);
  }).then(sn => {
    console.debug("[FASTBOOT] Device is in Fastboot mode, sn=", sn);
  });
}

/**
 * Checking whether a device is supported or not. This works whether in ADB or
 * in Fastboot mode. In each case, we do rely on the content of the
 * supportedDevices array. In each mode we will read a set of variables and we
 * will cross check for each element in this array if we have full match.
 **/
function isSupportedConfig(device, supportedDevice) {
  return new Promise((resolve, reject) => {
    if (device.type !== 'adb') {
      return reject('not_in_adb_mode');
    }

    // Get all ADB fields and check their values
    let allAdbFields = {};
    device.shell("getprop").then(props => {
      if (props === '') {
        return reject('failed to fetch props');
      }
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

      let anyPropNotGood = false;
      for (let prop in supportedDevice.adb) {
        let values = supportedDevice.adb[prop];

        let propVal = allAdbFields[prop];
        let isOk = (typeof values === "object") ?
          (values.indexOf(propVal) !== -1) : (values === propVal);

        if (!isOk) {
          console.error("Property match failure", prop, "expected one of", values, "but got", propVal)
          anyPropNotGood = true;
          break;
        }
      }

      if (!anyPropNotGood) {
        resolve(supportedDevice);
      } else {
        resolve(false);
      }

    }).catch(reason => {
      console.error("getprop:", reason);
      resolve(false);
    });
  });
}

/**
 * Relying on Devices.jsm to enumerate all connected devices that have been
 * exposed by the ADBHelper addon.
 **/
let Device = (function() {

  let devicePromise;
  let evts = {};

  function connected() {
    devicePromise = new Promise((resolve, reject) => {
      let devices = Devices.available();
      if (!devices.length) {
        reject();
        return;
      }

      let device = Devices._devices[devices[0]];
      let waitFun = (device.type === 'adb') ? waitForAdb : waitForFastboot;

      waitFun(device).then(() => {
        resolve(device);
        if ('connected' in evts) {
          evts.connected();
        }
      }).catch(err => {
        console.debug("Failure while waiting device: ", err);
        reject();
        return;
      });

    });
  }

  function disconnected() {
    devicePromise = null;
    if ('disconnected' in evts) {
      evts.disconnected();
    }
  }

  function get() {
    if (devicePromise) {
      return devicePromise;
    }
    return Promise.reject();
  }

  function on(evt, fun) {
    evts[evt] = fun;
  }

  function init() {
    Devices.on('register',   connected);
    Devices.on('unregister', disconnected);
    Devices.emit('adb-start-polling');
  }

  function uninit() {
    Devices.emit('adb-stop-polling');
    Devices.off('register',   connected);
    Devices.off('unregister', disconnected);
  }

  return {
    get: get,
    on: on,
    init: init,
    uninit: uninit
  };

})();

function getAvailableBuilds(device) {
  let configs = supportedDevices.map(config => {
    return isSupportedConfig(device, config);
  });

  return Promise.all(configs).then(results => {
    return results.filter(x => { return x !== false; });
  });
}

/** Let's do some things:
  *  - First extract the blobfree distribution zip
  *  - make sure everything is here
  *  - extract the blobfree content package
  *  - compute blobs map
  *  - extract recovery fstab infos
  */
let distributionContext = null;
function distributionStep(file, evt) {
  console.log("Extracting blob free distribution:", file);

  let rootDirImage, blobsMap, deviceFstab, deviceBuilds, deviceJson;

  return extractBlobFreeDistribution(file).then(root => {
    rootDirImage = root;
    console.log("Extracting blob free content:", rootDirImage);
    return extractBlobFreeContent(rootDirImage);
  }).then(result => {
    if (!result) {
      console.error("Error extracting content");
      return Promise.reject();
    }
    console.log("Blob free distribution extracted.");
    return readDevicesJson(rootDirImage);
  }).then(json => {
    deviceJson = json;
    console.log("Device descriptor read", deviceJson);
    return Device.get();
  }).then(device => {
    console.log("Checking device compatibility");
    return isSupportedConfig(device, deviceJson);
  }).then(builds => {
    if (builds.length === 0) {
      console.error("No compatible device.");
      return Promise.reject();
    }
    deviceBuilds = builds;
    console.log("Compatible device builds", deviceBuilds);
    return readBlobsMap(rootDirImage);
  }).then(map => {
    blobsMap = map;
    console.log("Blob map extracted, getting fstab");
    return readRecoveryFstab(rootDirImage);
  }).then(fstab => {
    deviceFstab = fstab;
    console.log("Recovery fstab read", deviceFstab);
  }).then(() => {
    distributionContext = {
      rootDirImage: rootDirImage,
      blobsMap: blobsMap,
      deviceFstab: deviceFstab,
      deviceBuilds: deviceBuilds
    };
  }).catch((error) => {
    console.error(error);
    distributionContext = null;
    return Promise.reject();
  });
}

function ensureRootIfNeeded() {
  // We consider that the default usecase is device will require rooting for
  // pulling blobs. So a missing requireRoot field is equivalent to true.
  let requiresRoot =
    distributionContext.deviceBuilds[0].requiresRoot === undefined ||
    distributionContext.deviceBuilds[0].requiresRoot === true;

  if (!requiresRoot) {
    console.log("Skipping adb root for this device");
    return Promise.resolve();
  }

  return Device.get().then(device => {
    return device.summonRoot();
  }).then(() => {
    console.log("Waiting for adb root to finish ...");
    // Avoid races conditions with adb root
    return new Promise((resolve, reject) => {
      console.debug("Starting root 5 secs countdown ...");
      setTimeout(() => {
        console.debug("Finished root 5 secs countdown  !");
        return resolve();
      }, 5000);
    });
  });
}

/** Let's do some things:
  *  - make sure device is plugged in and supported
  *  - get all the needed blobs
  *  - copy them to the extracted content directory
  */
let deviceContext = null;
function deviceStep(evt) {
  let adbDevice, runsB2G, applicationIni;
  return ensureRootIfNeeded().then(() => {
    return Device.get();
  }).then(device => {
    adbDevice = device;
    console.log("Checking B2G existence");
    return checkDeviceIsB2G(adbDevice);
  }).then(isB2G => {
    runsB2G = isB2G;
    console.log("B2G existence checked");
    return readApplicationIni(adbDevice);
  }).then(appIni => {
    console.log("Read appIni: ", appIni);
    applicationIni = appIni
    console.log("Pulling all blobs for", adbDevice);
    return getBlobs(adbDevice,
                    distributionContext.rootDirImage,
                    distributionContext.blobsMap);
  }).then(() => {
    deviceContext = {
      adbDevice: adbDevice,
      appIni: applicationIni,
      runsB2G: runsB2G
    };
  });
}

let imageContext = null;
function imageStep(evt) {

  let deviceFstab = distributionContext.deviceFstab;
  let runsB2G = deviceContext.runsB2G;
  let blobs = injectBlobs(distributionContext.rootDirImage,
                          distributionContext.blobsMap);

  return blobs.then(injected => {

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
    imageContext = {
      built: results
    };
  });
}

/** Let's do some things:
  *  - reboot device to fastboot mode and poll it
  *  - once detected, fastboot flash all partitions
  **/
function flashStep(evt) {

  let fastbootDevice;
  let adbDevice = deviceContext.adbDevice;
  let deviceFstab = distributionContext.deviceFstab;

  Devices.emit("fastboot-start-polling");

  return adbDevice.rebootBootloader().then(() => {
    console.debug("Device rebooting into in fastboot mode now.");

    // Avoid races conditions with adb reboot
    return new Promise((resolve, reject) => {
      console.debug("Starting 5 secs countdown ...");
      setTimeout(function() {
        console.debug("Finished 5 secs countdown  !");
        resolve();
      }, 10000);
    });
  }).then(() => {
    console.debug("Enumerating fastboot devices");
    return Device.get();
  }).then(device => {
    fastbootDevice = device;

    console.log("Devices enumerated, MUST be fastboot", fastbootDevice);

    if (!fastbootDevice.type === "fastboot") {
      console.error("We should have been into fastboot mode :(");
      return Promise.reject();
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
        downloadInfo('Flashing ' + fstabEntry.imageFile.split('/').pop());
        subInfo(currentImage + ' of ' + list.length);

        currentImage++;
        let flash = fastbootDevice.flash(fstabEntry.partition,
                                         fstabEntry.imageFile,
                                         fastbootDevice.id);
        flash.then(res => {
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
  }).then(() => {
    console.log("Rebooting from Fastboot to System");

    // Everything should be good now, rebooting device!
    return fastbootDevice.reboot(fastbootDevice.id);
  });
}

function drawBuild(build) {
  return `<li><label class="build">
    <input type="radio" value="${build.url}" name="build" />
    <div class="description">
      <h4>${build.name}</h4>
      <span>${build.description}</span>
    </div>
  </label></li>`;
}

function drawRow(device) {
  return device.builds.map(drawBuild).join('');
}

function percentStr(current, total) {
  return Math.round(((current * 1.0) / total) * 100) + '%';
}

function downloadInfo(info) {
  $('#additionalProgress')[0].textContent = info || '';
}

function subInfo(info) {
  $('#subAdditionalProgress')[0].textContent = info || '';
}

function downloadProgress(currentStep, info) {
  $('#progressDialog')[0].style.display = 'block';
  var steps = ['downloading', 'extracting', 'fetching', 'creating', 'flashing'];
  var done = true;
  steps.forEach(function(step) {
    var li = $('.' + step)[0];
    li.classList.remove('inprogress');
    if (step === currentStep) {
      li.classList.add('inprogress');
      done = false;
    }
    $('.' + step)[0].classList.toggle('done', done);
  });
  downloadInfo(info);
  subInfo('');
}

function currentStep(step) {
  $('#wrapper')[0].dataset.currentStep = step;
}

function step(step, fun) {
  return function() {
    downloadProgress(step);
    return fun.apply(null, arguments);
  };
}

// Downloads the blob free build from the server to a local
// tmp file
// TODO: cache
function downloadBuild() {

  let buildUrl = $('input[type=radio]:checked')[0].value;

  // If the build value isnt a url, its a local file the user uploaded
  // and we can skip the download
  if (!/^http/.test(buildUrl)) {
    return Promise.resolve(buildUrl);
  }

  var opts = {
    responseType: 'arraybuffer',
    progress: function(e) {
      if (e.lengthComputable) {
        var done = Math.round((e.loaded / e.total) * 100);
        var mb = Math.round(e.total / 1000 / 1000);
        downloadInfo('Downloaded ' + done + '% of ' + mb + 'MB');
      }
    }
  };

  var path;

  return xhr(buildUrl, opts).then(blob => {
    let name = buildUrl.split('/').pop();
    path = OS.Path.join(kB2GInstallerTmp, name);
    return OS.File.writeAtomic(path, new Uint8Array(blob));
  }).then(() => {
    return path;
  });
}

function install() {
  downloadProgress('downloading');
  downloadBuild()
    .then(step('extracting', distributionStep))
    .then(step('fetching', deviceStep))
    .then(step('creating', imageStep))
    .then(step('flashing', flashStep))
    .then(() => {
      $('#progressDialog')[0].style.display = 'none';
      $('#confirmDialog')[0].style.display = 'block';
    }).catch(e => {
      console.error('Installing failed');
      console.error(e);
      return Promise.reject();
    });
}


// SELECT BUILD
function buildAdded(evt) {
  var file = evt.target.files[0];
  var row = drawBuild({
    url: file.mozFullPath,
    name: file.name,
    description: ''
  });
  $('#devices')[0].insertAdjacentHTML('beforeend', row);
  $('#devices li:last-child input')[0].setAttribute('checked', 'checked');
  buildChecked();
}

function buildChecked(checked) {
  currentStep('flash')
}

// CONNECT DEVICE

// Device is connected, display to the user then show list of
// available builds to install
function deviceConnected() {
  let device;
  Device.get().then(_device => {
    device = _device;
    return getAvailableBuilds(device);
  }).then(builds => {
    var deviceName = device.id;
    if (builds.length) {
      // We dont get a human readable name from the device, pick
      // it up from the configuration name
      deviceName = builds[0].id;
    }
    $('#deviceId')[0].textContent = deviceName;
    $('#devices')[0].innerHTML = builds.map(drawRow).join('');
    currentStep('select');
  }).catch(err => {
    console.error(err);
  });
}

function deviceDisconnected() {
  currentStep('connect');
  $('#deviceId')[0].textContent = '';
  $('#devices')[0].innerHTML = '';
}

function done() {
  $('#confirmDialog')[0].style.display = 'none';
  currentStep('select');
};

function showOffline(isOffline) {
  document.getElementById('offline').style.visibility =
    isOffline ? "visible" : "hidden";
  document.getElementById('offline').style.display    =
    isOffline ? "block" : "none";
}

function downloadBuildsList() {
  // Only fetch the list of builds once
  if (supportedDevices && supportedDevices.length > 0) {
    console.error("Already supportedDevices: ", supportedDevices);
    return;
  }

  xhr(CONFIG_URL).then(data => {
    supportedDevices = data;
  }).catch(err => {
    showOffline(true);
    console.error(err);
    console.error('Failed to fetch valid builds.json: ', CONFIG_URL);
  });
}

addEventListener("offline", e => {
  console.log("offline");
  showOffline(true);
});

addEventListener("online", e => {
  console.log("online");
  showOffline(false);
  downloadBuildsList();
});

addEventListener("load", function load() {
  removeEventListener("load", load, false);

  showOffline(!navigator.onLine);

  $('#userBuild')[0].addEventListener('change', buildAdded.bind(null));
  $('#devices')[0].addEventListener('change', buildChecked.bind(null));
  $('#installBtn')[0].addEventListener('click', install.bind(null));
  $('#confirmDialog button')[0].addEventListener('click', done.bind(null));

  Device.on('connected', deviceConnected.bind(null, true));
  Device.on('disconnected', deviceDisconnected.bind(null, true));
  Device.init();

  downloadBuildsList();
}, false);

addEventListener("unload", function unload() {
  removeEventListener("unload", unload, false);
  $('#userBuild')[0].mozSetFileNameArray([], 0);
  Device.uninit();
  Devices.emit("adb-stop-polling");
  Devices.emit("fastboot-stop-polling");
}, false);
