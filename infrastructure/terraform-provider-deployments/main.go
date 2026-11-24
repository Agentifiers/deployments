package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/Agentifiers/deployments/infrastructure/terraform-provider-deployments/internal/provider"
)

var version = "0.1.0"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "terraform.local/deployments-ai/deployments",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
