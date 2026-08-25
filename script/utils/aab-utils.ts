// Minimal Android App Bundle (.aab) manifest reader; replaces the unmaintained
// aab-parser, which pinned a vulnerable protobufjs (^6.11.2).

import * as protobuf from "protobufjs";
import * as yauzl from "yauzl";
import { buffer as readStreamToBuffer } from "node:stream/consumers";

export type AabManifest = {
    versionCode: number;
    versionName: string;
    packageName: string;
    compiledSdkVersion: number;
    compiledSdkVersionCodename: number;
};

type ManifestAttribute = { name: string; value: string };

const MANIFEST_ENTRY_NAME = "base/manifest/AndroidManifest.xml";

// An AAB's <manifest> is protobuf-encoded as an aapt.pb.XmlNode. We only read a
// few attributes, so we declare just that slice (field numbers from AOSP
// aapt2/Resources.proto); the decoder skips every field we omit.
const XmlNode = protobuf.parse(`
    syntax = "proto3";
    package aapt.pb;
    message XmlAttribute { string name = 2; string value = 3; }
    message XmlElement { string name = 3; repeated XmlAttribute attribute = 4; }
    message XmlNode { XmlElement element = 1; }
`).root.lookupType("aapt.pb.XmlNode");

async function readManifestAttributes(file: string | Buffer): Promise<ManifestAttribute[]> {
    const zipFile = typeof file === "string" ? await yauzl.openPromise(file) : await yauzl.fromBufferPromise(file);

    let manifest: Buffer | undefined;
    for await (const entry of zipFile.eachEntry()) {
        if (entry.fileName !== MANIFEST_ENTRY_NAME) continue;
        manifest = await readStreamToBuffer(await zipFile.openReadStreamPromise(entry));
        break; // breaking out of eachEntry() closes the zip file for us
    }

    if (manifest === undefined) {
        throw new Error("Could not find AndroidManifest.xml file inside the app bundle file");
    }

    const decoded = XmlNode.decode(manifest).toJSON() as { element?: { attribute?: ManifestAttribute[] } };
    return decoded.element?.attribute ?? [];
}

export async function parseAabManifest(file: string | Buffer): Promise<AabManifest> {
    const attributes = await readManifestAttributes(file);

    function getAttribute(name: string): string {
        const attribute = attributes.find((attr) => attr.name === name);
        if (attribute === undefined) {
            throw new Error(`Attribute "${name}" not found in AndroidManifest.xml`);
        }
        return attribute.value;
    }

    return {
        versionCode: Number(getAttribute("versionCode")),
        versionName: getAttribute("versionName"),
        packageName: getAttribute("package"),
        compiledSdkVersion: Number(getAttribute("compileSdkVersion")),
        compiledSdkVersionCodename: Number(getAttribute("compileSdkVersionCodename")),
    };
}
