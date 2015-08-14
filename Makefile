FILES=about.css about.js about.xhtml bootstrap.js imaging_tools.js main.js subprocess.js chrome.manifest Fira checkmark.png spinner.png
ADDON_VERSION=0.3
XPI_NAME=b2g-installer-$(ADDON_VERSION)

XPIS = $(XPI_NAME)-linux.xpi $(XPI_NAME)-linux64.xpi $(XPI_NAME)-mac64.xpi

all: $(XPIS)

define build-xpi
	echo "build xpi for $1";
	sed -e 's#@@ADDON_VERSION@@#$(ADDON_VERSION)#' template-install.rdf > install.rdf
	zip $(XPI_NAME)-$1.xpi -r $2 install.rdf
endef

# $(XPI_NAME)-win32.xpi: $(FILES) subprocess_worker_win.js win32
#	@$(call build-xpi,win32, $^)

$(XPI_NAME)-linux.xpi: $(FILES) subprocess_worker_unix.js linux
	@$(call build-xpi,linux, $^)

$(XPI_NAME)-linux64.xpi: $(FILES) subprocess_worker_unix.js linux64
	@$(call build-xpi,linux64, $^)

$(XPI_NAME)-mac64.xpi: $(FILES) subprocess_worker_unix.js mac64
	@$(call build-xpi,mac64, $^)

clean:
	rm -f $(XPI_NAME)*.xpi
	rm -f install.rdf
