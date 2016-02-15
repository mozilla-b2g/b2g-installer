FILES=about.css about.js about.xhtml bootstrap.js imaging_tools.js main.js subprocess.js chrome.manifest Fira checkmark.png spinner.png Header.png Header_Gradient.png Connect_Icon_130x130.png Flash_Icon_130x130.png Select_Icon_130x130.png Firefox_Installer_Title.png

ADDON_VERSION ?= 0.9.1

XPI_NAME=b2g-installer-$(ADDON_VERSION)
XPIS ?= $(XPI_NAME)-linux.xpi $(XPI_NAME)-linux64.xpi $(XPI_NAME)-mac64.xpi

UPDATE_URL    ?= https://lissyx.github.io/b2g-installer/@@PLATFORM@@/update.rdf
UPDATE_LINK   ?= https://lissyx.github.io/b2g-installer/${XPI_NAME}-@@PLATFORM@@.xpi

all: $(XPIS)

define build-install
	echo "build install.rdf for $1";
	sed -e 's#@@ADDON_VERSION@@#$(ADDON_VERSION)#' \
	    -e 's#@@UPDATE_URL@@#${UPDATE_URL}#' \
	    -e 's#@@PLATFORM@@#$1#' \
	    template-install.rdf > $1/install.rdf
endef

linux/install.rdf:
	$(call build-install,linux)
linux64/install.rdf:
	$(call build-install,linux64)
mac64/install.rdf:
	$(call build-install,mac64)

.PHONY: linux/install.rdf linux64/install.rdf mac64/install.rdf install.rdf
install.rdf: linux/install.rdf linux64/install.rdf mac64/install.rdf

define build-update
	echo "build update.rdf for $1";
	sed -e 's#@@ADDON_VERSION@@#$(ADDON_VERSION)#' \
	    -e 's#@@UPDATE_LINK@@#${UPDATE_LINK}#' \
	    -e 's#@@PLATFORM@@#$1#' \
	    template-update.rdf > $1/update.rdf
endef

linux/update.rdf:
	$(call build-update,linux)
linux64/update.rdf:
	$(call build-update,linux64)
mac64/update.rdf:
	$(call build-update,mac64)

.PHONY: linux/update.rdf linux64/update.rdf mac64/update.rdf update.rdf
update.rdf: linux/update.rdf linux64/update.rdf mac64/update.rdf

.PHONY: index.html
index.html: index.html.tmpl
	sed -e 's#@@ADDON_VERSION@@#$(ADDON_VERSION)#' index.html.tmpl > index.html

updates.zip: update.rdf index.html
	zip updates.zip */update.rdf index.html $(XPIS)
	echo "PLEASE REMEMBER TO unzip updates.zip AFTER |git checkout gh-pages|"

dorelease: $(XPIS) updates.zip
	echo "XPIs for version $(ADDON_VERSION) are ready"
	echo "Update manifest are ready"
	echo "Index page is ready"
	rm b2g-installer-*.xpi
	git checkout gh-pages
	git rm b2g-installer-*.xpi
	unzip -o updates.zip
	git add index.html */update.rdf $(XPIS)
	git commit -m "Pushing release v$(ADDON_VERSION)" && git tag b2g-installer-v$(ADDON_VERSION)

clean:
	rm -f $(XPI_NAME)*.xpi
	rm -f install.rdf
