FILES=about.css about.js about.xhtml bootstrap.js imaging_tools.js main.js subprocess.js chrome.manifest Fira checkmark.png spinner.png Header.png Header_Gradient.png Connect_Icon_130x130.png Flash_Icon_130x130.png Select_Icon_130x130.png Firefox_Installer_Title.png
ADDON_VERSION=0.9
XPI_NAME=b2g-installer-$(ADDON_VERSION)

XPIS = $(XPI_NAME)-linux.xpi $(XPI_NAME)-linux64.xpi $(XPI_NAME)-mac64.xpi

all: $(XPIS)

install.rdf: template-install.rdf
	sed -e 's#@@ADDON_VERSION@@#$(ADDON_VERSION)#' template-install.rdf > install.rdf

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
