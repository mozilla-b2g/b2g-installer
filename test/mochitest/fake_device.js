/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

function FakeAdbDevice(serial) {
  this._serial = serial || "88ccd442e1131";
  this.id      = this._serial;
}

FakeAdbDevice.prototype = {
  type:  "adb",
  model: "Fake Device",
  _props: {
    "ro.product.model": "FakeDevice 2.0",
    "ro.bootloader": "1.0.0",
    "ro.build.id": "L"
  },
  _files: { },

  getModel: function() {
    dump("FakeAdbDevice.getModel()\n");
    return new Promise((resolve, reject) => {
      resolve(this.model);
    });
  },

  pull: function(file) {
    dump("FakeAdbDevice.pull(" + file + ")\n");
    return new Promise((resolve, reject) => {
      resolve();
    });
  },

  rebootBootloader: function() {
    dump("FakeAdbDevice.rebootBootloader()\n");
    return new Promise((resolve, reject) => {
      resolve();
    });
  },

  summonRoot: function() {
    dump("FakeAdbDevice.summonRoot()\n");
    return new Promise((resolve, reject) => {
      resolve();
    });
  },

  shell: function(cmds) {
    dump("FakeAdbDevice.shell(" + cmds + ")\n");
    return new Promise((resolve, reject) => {
      let output = "";
      let args = cmds.split(" ");

      switch(args[0]) {
        case "getprop": {
          Object.keys(this._props).forEach(k => {
            output += "[" + k + "]: " + "[" + this._props[k] + "]\n";
          });
          break;
        }

        case "ls": {
          let fileExists = Object.keys(this._files).indexOf(args[1]) !== -1;
          if (fileExists) {
            output = args[1];
          } else {
            output = "ls: cannot access " + args[1] + ": No such file or directory";
          }
          break;
        }

        case "cat": {
          let fileExists = Object.keys(this._files).indexOf(args[1]) !== -1;
          if (fileExists) {
            output = this._files[args[1]];
          } else {
            output = "cat: cannot access " + args[1] + ": No such file or directory";
          }
          break;
        }

        default:
          return reject("unsupported command", args[0]);
      }

      resolve(output);
    });
  }
};

function FakeFastbootDevice(serial) {
  this._serial        = serial || "88ccd442e1131";
  this.id             = this._serial;
  this._vars.serialno = this._serial;

  // array of {"name": "PARTITION", "img": "IMAGE"}
  this._flashed = [];
}

FakeFastbootDevice.prototype = {
  type:  "fastboot",
  model: "Fake Device",
  _vars: {
    "product": "FD2",
    "version-bootloader": "UBoot-2.0"
  },

  flash: function(partition, image) {
    dump("FakeFastbootDevice.flash(" + partition + ", " + image + ")\n");
    return new Promise((resolve, reject) => {
      let timeout;
      switch(partition) {
        case "boot":
        case "recovery":
          timeout = 1.5;
          break;
        case "data":
        case "userdata":
          timeout = 2;
          break;
        case "system":
          timeout = 4;
          break;
        default:
          return reject("Unknown partition:", partition);
      }

      dump("FakeFastbootDevice.flash() waiting " + timeout + " secs\n");
      setTimeout(() => {
        this._flashed.push({"name": partition, "img": image});
        return resolve();
      }, timeout * 1000);
    });
  },

  getvar: function(name) {
    dump("FakeFastbootDevice.getvar(" + name + ")\n");
    return new Promise((resolve, reject) => {
      if (!this._vars[name]) {
        reject();
      } else {
        resolve(this._vars[name]);
      }
    });
  },

  reboot: function(file) {
    dump("FakeFastbootDevice.reboot()\n");
    return new Promise((resolve, reject) => {
      resolve();
    });
  }
};
