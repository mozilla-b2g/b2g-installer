#!/bin/sh

set -ex

### ORIGIN=origin
### BRANCH=b2ginstaller_tools
### REPO=git://github.com/lissyx/mozilla-central.git
### 
### REMOTE=mozillaorg
### REMOTEBRANCH=master
### REMOTEREPO=git://github.com/mozilla/gecko-dev.git
### 
### TODAY=$(date +%Y%m%d)
### 
### git clone --depth 3 --branch ${BRANCH} ${REPO} ${DIR} && cd ${DIR} && \
### git remote add ${REMOTE} ${REMOTEREPO} && git fetch --depth 3 ${REMOTE} && \
### git checkout -b b2ginstaller_${TODAY} ${ORIGIN}/${BRANCH} && \
### git rebase ${REMOTE}/${REMOTEBRANCH}

ADDON_DIR=$(pwd)

make install.rdf

# cd ../ && \
# wget https://github.com/mozilla/gecko-dev/archive/master.zip -O /tmp/gecko-dev-master.zip && \
# unzip -q /tmp/gecko-dev-master.zip

git clone --depth 1 --single-branch --branch master git://github.com/mozilla/gecko-dev.git ${GECKO_DIR}

cd ${GECKO_DIR} && \
patch -p1 < ${ADDON_DIR}/add-b2ginstaller-mozbuild.patch && \
ln -s ${ADDON_DIR} browser/extensions/b2g-installer && \
cat > .mozconfig <<EOF
ac_add_options --enable-application=browser
mk_add_options AUTOCLOBBER=1
EOF
