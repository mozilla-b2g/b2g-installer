#!/bin/bash

set -ex

cd .. && wget http://ftp.gnu.org/gnu/autoconf/autoconf-2.13.tar.gz -O /tmp/autoconf-2.13.tar.gz && tar xf /tmp/autoconf-2.13.tar.gz
cd autoconf-2.13 && \
./configure \
	--prefix=${AUTOCONF_INST} \
	--program-suffix=2.13 && \
make && make install

PATH=${AUTOCONF_PATH}:$PATH autoconf2.13 --version
