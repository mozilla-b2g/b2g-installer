#!/bin/bash

set -ex

export PATH=${AUTOCONF_PATH}:$PATH
export CC=gcc-4.8
export CXX=g++-4.8

cd ${GECKO_DIR} && \
./mach build && \
./mach build package

zipinfo -l obj-*/dist/xpi-stage/b2g-installer/*.xpi
