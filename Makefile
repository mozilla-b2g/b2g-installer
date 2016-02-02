FILES=about.css about.js about.xhtml bootstrap.js imaging_tools.js main.js subprocess.js chrome.manifest Fira checkmark.png spinner.png Header.png Header_Gradient.png Connect_Icon_130x130.png Flash_Icon_130x130.png Select_Icon_130x130.png Firefox_Installer_Title.png

ADDON_VERSION ?= 0.9

XPI_NAME=b2g-installer-$(ADDON_VERSION)
XPIS = $(XPI_NAME)-linux.xpi $(XPI_NAME)-linux64.xpi $(XPI_NAME)-mac64.xpi

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
	zip updates.zip $^
	echo "PLEASE REMEMBER TO unzip updates.zip AFTER |git checkout gh-pages|"

define build-xpi
	echo "build xpi for $1";
	zip $(XPI_NAME)-$1.xpi -r $2 install.rdf
endef

# $(XPI_NAME)-win32.xpi: $(FILES) subprocess_worker_win.js win32
#	@$(call build-xpi,win32, $^)

$(XPI_NAME)-linux.xpi: $(FILES) install.rdf subprocess_worker_unix.js linux
	@$(call build-xpi,linux, $^)

$(XPI_NAME)-linux64.xpi: $(FILES) install.rdf subprocess_worker_unix.js linux64
	@$(call build-xpi,linux64, $^)

$(XPI_NAME)-mac64.xpi: $(FILES) install.rdf subprocess_worker_unix.js mac64
	@$(call build-xpi,mac64, $^)

clean:
	rm -f $(XPI_NAME)*.xpi
	rm -f install.rdf
