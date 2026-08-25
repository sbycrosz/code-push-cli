// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as Q from "q";
import * as sinon from "sinon";
import * as cmdexec from "../script/command-executor";
import * as cli from "../script/types/cli";
import {
  ASSET_OPTIMIZATION_DOCS_URL,
  MAX_ASSET_SIZE_BYTES,
  MAX_BUNDLE_SIZE_BYTES,
  SENTRY_SOURCE_MAP_DOCS_URL,
} from "../script/utils/release-size-utils";

describe("Release size flow", () => {
  let assetSize: number;
  let bundleSize: number;
  let includeSourceMap: boolean;
  let originalCwd: string;
  let outputDirectory: string;
  let projectDirectory: string;
  let sandbox: sinon.SinonSandbox;
  let sdkRelease: sinon.SinonStub;
  let warning: sinon.SinonStub;

  beforeEach(() => {
    assetSize = 1;
    bundleSize = 1;
    includeSourceMap = false;
    originalCwd = process.cwd();
    projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "revopush-release-flow-"));
    outputDirectory = path.join(projectDirectory, "release-output");
    createProject(projectDirectory);
    process.chdir(projectDirectory);

    sandbox = sinon.createSandbox();
    sdkRelease = sandbox.stub().returns(Q(<void>null));
    sandbox.stub(cmdexec, "sdk").value({
      getDeployment: sandbox.stub().returns(Q({})),
      isAuthenticated: sandbox.stub().returns(Q(true)),
      release: sdkRelease,
    });
    sandbox.stub(cmdexec, "log");
    sandbox.stub(console, "log");
    sandbox.stub(cmdexec, "spawn").callsFake((_command: string, args: string[]) => {
      const bundleOutputIndex = args.indexOf("--bundle-output");
      const assetsDestinationIndex = args.indexOf("--assets-dest");
      const bundlePath = args[bundleOutputIndex + 1];
      const assetsDestination = args[assetsDestinationIndex + 1];

      createSizedFile(bundlePath, bundleSize);
      createSizedFile(path.join(assetsDestination, "assets", "hero.png"), assetSize);
      if (includeSourceMap) {
        createSizedFile(path.join(assetsDestination, "assets", "main.jsbundle.map"), 1);
      }

      return <any>{
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, callback: (exitCode: number) => void) => {
          if (event === "close") {
            callback(0);
          }
        },
      };
    });
    warning = sandbox.stub(console, "warn");
  });

  afterEach(() => {
    sandbox.restore();
    process.chdir(originalCwd);
    fs.rmSync(projectDirectory, { recursive: true, force: true });
  });

  it("blocks release-react before upload when an asset is oversized", async () => {
    assetSize = MAX_ASSET_SIZE_BYTES + 1;
    includeSourceMap = true;

    await assert.rejects(
      Promise.resolve(cmdexec.releaseReact(createCommand(cli.CommandType.releaseReact, false))),
      (error: Error) => error.message.includes("--force") && error.message.includes(ASSET_OPTIMIZATION_DOCS_URL)
    );

    sinon.assert.notCalled(sdkRelease);
    sinon.assert.calledOnce(warning);
    assert.ok(warning.firstCall.args[0].includes("main.jsbundle.map"));
    assert.ok(warning.firstCall.args[0].includes(SENTRY_SOURCE_MAP_DOCS_URL));
  });

  it("warns about source maps without blocking release-react", async () => {
    includeSourceMap = true;

    await Promise.resolve(cmdexec.releaseReact(createCommand(cli.CommandType.releaseReact, false)));

    sinon.assert.calledOnce(sdkRelease);
    sinon.assert.calledOnce(warning);
    assert.ok(warning.firstCall.args[0].includes("main.jsbundle.map"));
    assert.ok(warning.firstCall.args[0].includes(SENTRY_SOURCE_MAP_DOCS_URL));
  });

  it("uploads release-expo with force and prints warnings after upload succeeds", async () => {
    const events: string[] = [];
    assetSize = MAX_ASSET_SIZE_BYTES + 1;
    bundleSize = MAX_BUNDLE_SIZE_BYTES + 1;
    sdkRelease.callsFake(() =>
      Q(<void>null).then(() => {
        events.push("upload-completed");
      })
    );
    warning.callsFake(() => {
      events.push("warning");
    });

    await Promise.resolve(cmdexec.releaseExpo(createCommand(cli.CommandType.releaseExpo, true)));

    sinon.assert.calledOnce(sdkRelease);
    sinon.assert.calledOnce(warning);
    assert.deepEqual(events, ["upload-completed", "warning"]);
    assert.ok(warning.firstCall.args[0].includes("hero.png"));
    assert.ok(warning.firstCall.args[0].includes("diff updates"));
  });

  it("does not print deferred warnings when upload fails", async () => {
    assetSize = MAX_ASSET_SIZE_BYTES + 1;
    bundleSize = MAX_BUNDLE_SIZE_BYTES + 1;
    sdkRelease.returns(Q.reject(new Error("Upload failed")));

    await assert.rejects(Promise.resolve(cmdexec.releaseExpo(createCommand(cli.CommandType.releaseExpo, true))), /Upload failed/);

    sinon.assert.calledOnce(sdkRelease);
    sinon.assert.notCalled(warning);
  });

  function createCommand(type: cli.CommandType, force: boolean): cli.IReleaseReactCommand {
    return {
      type,
      appName: "TestApp",
      appStoreVersion: "1.0.0",
      bundleName: "main.jsbundle",
      deploymentName: "Staging",
      description: "Release size test",
      development: false,
      disabled: false,
      entryFile: "index.js",
      extraBundlerOptions: [],
      extraHermesFlags: [],
      force,
      mandatory: false,
      outputDir: outputDirectory,
      platform: "ios",
      rollout: 100,
      sourcemapOutput: path.join(projectDirectory, "main.jsbundle.map"),
    };
  }

  function createProject(directory: string): void {
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "TestApp", dependencies: { expo: "1.0.0", "react-native": "0.60.0" } })
    );
    fs.writeFileSync(path.join(directory, "index.js"), "module.exports = {};\n");
    fs.mkdirSync(path.join(directory, "node_modules", "react-native"), { recursive: true });
    fs.writeFileSync(path.join(directory, "node_modules", "react-native", "package.json"), JSON.stringify({ version: "0.60.0" }));
    fs.mkdirSync(path.join(directory, "node_modules", "@expo", "cli"), { recursive: true });
    fs.writeFileSync(path.join(directory, "node_modules", "@expo", "cli", "index.js"), "module.exports = {};\n");
  }

  function createSizedFile(filePath: string, size: number): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.closeSync(fs.openSync(filePath, "w"));
    fs.truncateSync(filePath, size);
  }
});
