/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { Cc, Ci, Cu, Cr } = require("chrome");
const { XPCOMABI } = require("sdk/system/runtime");
const subprocess = require("./subprocess");

const { OS } = Cu.import("resource://gre/modules/osfile.jsm", {});

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "ppmm", function() {
  return Cc["@mozilla.org/parentprocessmessagemanager;1"]
         .getService(Ci.nsIMessageListenerManager);
});

function getUint8Array(str) {
  let uint = new Uint8Array(str.length);
  for (let i = 0, j = str.length; i < j; ++i) {
    uint[i] = str.charCodeAt(i);
  }
  return uint;
}

function gzipCompressString(string, obs) {

  let scs = Cc["@mozilla.org/streamConverters;1"]
           .getService(Ci.nsIStreamConverterService);
  let listener = Cc["@mozilla.org/network/stream-loader;1"]
                .createInstance(Ci.nsIStreamLoader);
  listener.init(obs);
  let converter = scs.asyncConvertData("uncompressed", "gzip",
                                        listener, null);
  let stringStream = Cc["@mozilla.org/io/string-input-stream;1"]
                    .createInstance(Ci.nsIStringInputStream);
  stringStream.data = string;
  converter.onStartRequest(null, null);
  converter.onDataAvailable(null, null, stringStream, 0, string.length);
  converter.onStopRequest(null, null, null);
}

function ImagingTools() {
  this._tools = [ "mkbootfs", "mkbootimg", "make_ext4fs" ];
  this._paths = {};
  this.init();
}

ImagingTools.prototype = {
  init: function() {
    this.detectBinaries();

    ppmm.addMessageListener("B2GInstaller:MainProcess:BuildRamdisk", this);
    ppmm.addMessageListener("B2GInstaller:MainProcess:BuildBootable", this);
    ppmm.addMessageListener("B2GInstaller:MainProcess:BuildExt4FS", this);
  },

  detectBinaries: function() {
    let platform = Services.appinfo.OS;
    let uri = "resource://b2g-installeratmozilla.org/";

    console.log("Checking existence of", this._tools, "for", platform, "within", uri);

    this._tools.forEach(tool => {
      console.debug("Checking for tool", tool);

      let binary, system;

      switch (platform) {
        case "Linux":
          system = XPCOMABI.indexOf("x86_64") == 0 ? "linux64" : "linux";
          binary = tool;
          break;
        case "Darwin":
          system = "mac64";
          binary = tool;
          break;
        case "WINNT":
          system = "win32";
          binary = tool + ".exe";
          break;
        default:
          console.error("Unsupported platform", platform);
          return;
      }

      console.debug("Looking into", uri, system, "for", binary);
      let bin = uri + system + "/" + binary;
      let url = Services.io.newURI(bin, null, null)
                        .QueryInterface(Ci.nsIFileURL);

      if (!url.file.exists()) {
        console.error("Unable to find", url.file);
        return;
      }

      // Finally, save it.
      console.debug("Tool", tool, "at", url.file.path);
      this._paths[tool] = url.file;
    });

    console.log("All tools have been picked up.");
  },

  receiveMessage: function(msg) {
    console.debug("Received:", msg);
    // msg.target.sendAsyncMessage("B2GInstaller:About", { "fastboot": true, "adb": false});

    let options = msg.data;
    switch (msg.name) {
      case "B2GInstaller:MainProcess:BuildRamdisk":
        this.executeTool("mkbootfs", options).then(res => {
          msg.target.sendAsyncMessage("B2GInstaller:MainProcess:BuildRamdisk:Return", { res: res, req: options });
        });
        break;

      case "B2GInstaller:MainProcess:BuildBootable":
        this.executeTool("mkbootimg", options).then(res => {
          msg.target.sendAsyncMessage("B2GInstaller:MainProcess:BuildBootable:Return", { res: res, req: options });
        });
        break;

      case "B2GInstaller:MainProcess:BuildExt4FS":
        this.executeTool("make_ext4fs", options).then(res => {
          msg.target.sendAsyncMessage("B2GInstaller:MainProcess:BuildExt4FS:Return", { res: res, req: options });
        });
        break;

      default:
        console.error("Unsupported message:", msg.name);
        break;
    }
  },

  getTool: function(name) {
    if (Object.keys(this._paths).indexOf(name) === -1) {
      console.error("Trying to use inexistent tool", name);
      return;
    }

    return this._paths[name];
  },

  mkbootfs: function(options) {
    return new Promise((resolve, reject) => {
      // Build a cpio archive ramdisk and gzip it
      let cpioContent = "";
      subprocess.call({
        command: this.getTool("mkbootfs"),
        charset: null, // make sure we get a binary stream
        arguments: [ options.from ],
        stdout: function(cpio) {
          cpioContent += cpio;
        },
        done: function() {
          let observer = {
            onStreamComplete: function(loader, context, status, length, result) {
              let payload = new Uint8Array(length);
              payload.set(result, 0);
              console.debug("About to write", payload.byteLength, "bytes ...");
              OS.File.writeAtomic(options.to, payload, { }).then(
                function onSuccess(bytes) {
                  let expected = new FileUtils.File(options.to);
                  if (expected.exists()) {
                    console.debug("Written gzip'd cpio", bytes," bytes to", options.to);
                    resolve(true);
                  } else {
                    console.debug("Error checking gzip'd cpio", bytes," bytes to", options.to);
                    reject(true);
                  }
                },
                function onFailure() {
                  console.debug("Unable to write gzip'd cpio to", options.to);
                  resolve(false);
                }
              );
            }
          };
          gzipCompressString(cpioContent, observer);
        }
      });
    });
  },

  mkbootimg: function(options) {
    /**
    pushd "${IMAGE_DIR}/${src}";
      ../../mkbootimg \
        --kernel "kernel" \
        --ramdisk "initrd.img" \
        --cmdline "`cat cmdline`" \
        --pagesize "`cat pagesize`" \
        --base "`cat base`" \
        --dt "../../dt.img" \
        --output "../../${img}"
    **/

    let args = [];
    args.push("--kernel",   options.kernel);
    args.push("--ramdisk",  options.ramdisk);
    args.push("--cmdline",  options.cmdline);
    args.push("--pagesize", options.pagesize);
    args.push("--base",     options.base);

    if (options.dt) {
      args.push("--dt", options.dt);
    }

    if (options.extraArguments) {
      let extraArguments = options.extraArguments.trim().split(/ +/);
      args = args.concat(extraArguments);
    }

    args.push("--output", options.output);

    return new Promise((resolve, reject) => {
      // Build an Android boot image
      subprocess.call({
        command: this.getTool("mkbootimg"),
        arguments: args,
        stdout: function(data) {
          console.debug("STDOUT:", data);
        },
        done: function() {
          let expected = new FileUtils.File(options.output);
          if (expected.exists()) {
            resolve(true);
          } else {
            reject(true);
          }
        }
      });
    });
  },

  make_ext4fs: function(options) {
    /**
      ./make_ext4fs `cat "${DEVICE}-cmdline-fs.txt" | grep ^system|cut -d':' -f2` "system.img" "${IMAGE_DIR}/SYSTEM/"
    **/

    // cmdline_fs may include multiple spaces between arguments
    let args = options.cmdline_fs.split(/ +/);
    args.push(options.image);
    args.push(options.source);

    return new Promise((resolve, reject) => {
      // Build an Android system partition image
      subprocess.call({
        command: this.getTool("make_ext4fs"),
        arguments: args,
        stdout: function(data) {
          console.debug("STDOUT:", data);
        },
        done: function() {
          let expected = new FileUtils.File(options.image);
          if (expected.exists()) {
            resolve(true);
          } else {
            reject(true);
          }
        }
      });
    });
  },

  executeTool: function(name, options) {
    if (!this.getTool(name)) {
      return;
    }

    console.debug("Calling", name, "with", options);
    return this[name](options);
  }
};

module.exports = new ImagingTools();

/* vim: set et ts=2 sw=2 : */
