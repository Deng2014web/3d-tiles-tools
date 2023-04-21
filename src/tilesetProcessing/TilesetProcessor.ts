import { Buffers } from "../base/Buffers";
import { DeveloperError } from "../base/DeveloperError";

import { ContentDataTypeRegistry } from "../contentTypes/ContentDataTypeRegistry";

import { Tileset } from "../structure/Tileset";
import { Schema } from "../structure/Metadata/Schema";

import { TilesetError } from "../tilesetData/TilesetError";
import { TilesetTargets } from "../tilesetData/TilesetTargets";
import { TilesetSources } from "../tilesetData/TilesetSources";
import { TilesetEntry } from "../tilesetData/TilesetEntry";

import { Tilesets } from "../tilesets/Tilesets";

import { TilesetEntryProcessor } from "./TilesetEntryProcessor";
import { TilesetProcessorContext } from "./TilesetProcessorContext";
import { TilesetSource } from "../tilesetData/TilesetSource";
import { TilesetTarget } from "../tilesetData/TilesetTarget";

/**
 * A base class for classes that can process tilesets.
 *
 * This class offers the infrastructure for opening a `TilesetSource`
 * and a `TilesetTarget`, parsing the `Tileset` object from the
 * source, and performing operations on `Tileset` and the
 * `TilesetEntry` objects.
 *
 * Subclasses will offer predefined sets of operations that can
 * be performed on the `Tileset` and the `TilesetEntry` objects.
 */
export abstract class TilesetProcessor {
  /**
   * A function that will receive log messages
   */
  private readonly logCallback: (message: any) => void;

  /**
   * The context that was created in `begin`
   */
  private context: TilesetProcessorContext | undefined;

  /**
   * Creates a new instance
   *
   * @param quiet - Whether log messages should be omitted
   */
  constructor(quiet?: boolean) {
    if (quiet !== true) {
      this.logCallback = (message: any) => console.log(message);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
      this.logCallback = (message: any) => {};
    }
  }

  /**
   * Internal method to just call the log callback
   *
   * @param message - The message
   */
  protected log(message: any): void {
    this.logCallback(message);
  }

  /**
   * Returns the `TilesetProcessorContext` that contains all
   * elements that are required for processing the tileset
   *
   * @returns The `TilesetProcessorContext`
   * @throws DeveloperError If `begin` was not called yet
   */
  protected getContext(): TilesetProcessorContext {
    if (!this.context) {
      throw new DeveloperError(
        "The processor was not initialized. Call 'begin' first."
      );
    }
    return this.context;
  }

  /**
   * Prepare processing the given tileset source and writing
   * the results into the given tileset target.
   *
   * @param tilesetSourceName - The tileset source name
   * @param tilesetTargetName - The tileset target name
   * @param overwrite Whether the target should be overwritten if
   * it already exists
   * @returns A promise that resolves when this processor has been
   * initialized
   * @throws TilesetError When the input could not be opened,
   * or when the output already exists and `overwrite` was `false`.
   */
  async begin(
    tilesetSourceName: string,
    tilesetTargetName: string,
    overwrite: boolean
  ): Promise<void> {
    if (this.context) {
      throw new TilesetError("Processing has already begun");
    }
    let tilesetSource;
    let tilesetTarget;
    try {
      tilesetSource = TilesetSources.createAndOpen(tilesetSourceName);
      tilesetTarget = TilesetTargets.createAndBegin(
        tilesetTargetName,
        overwrite
      );

      const tilesetSourceJsonFileName =
        Tilesets.determineTilesetJsonFileName(tilesetSourceName);

      const tilesetTargetJsonFileName =
        Tilesets.determineTilesetJsonFileName(tilesetTargetName);

      // Obtain the tileset object from the tileset JSON file
      const parsedTileset = TilesetProcessor.parseSourceValue<Tileset>(
        tilesetSource,
        tilesetSourceJsonFileName
      );

      // Resolve the schema, either from the `tileset.schema`
      // or the `tileset.schemaUri`
      const schema = TilesetProcessor.resolveSchema(
        tilesetSource,
        parsedTileset.result
      );

      // If nothing has thrown up to this point, then
      // a `TilesetProcessorContext` with a valid
      // state can be created:
      this.context = {
        tilesetSource: tilesetSource,
        tilesetSourceJsonFileName: tilesetSourceJsonFileName,
        tileset: parsedTileset.result,
        tilesetJsonWasZipped: parsedTileset.wasZipped,
        schema: schema,
        tilesetTarget: tilesetTarget,
        tilesetTargetJsonFileName: tilesetTargetJsonFileName,
        processedKeys: {},
        targetKeys: {},
      };
    } catch (error) {
      if (tilesetSource) {
        try {
          tilesetSource.close();
        } catch (e) {
          // Error already about to be re-thrown
        }
      }
      if (tilesetTarget) {
        try {
          await tilesetTarget.end();
        } catch (e) {
          // Error already about to be re-thrown
        }
      }
      delete this.context;
      throw error;
    }
  }

  /**
   * Finish processing the source tileset and write all entries
   * that have not been processed yet into the target.
   *
   * @returns A promise that resolves when the operation finished
   * @throws TilesetError When there was an error while processing
   * or storing the entries.
   */
  async end() {
    const context = this.getContext();
    const tilesetSource = context.tilesetSource;
    const tilesetTarget = context.tilesetTarget;
    const tilesetSourceJsonFileName = context.tilesetSourceJsonFileName;

    // Perform a no-op on all entries that have not yet
    // been marked as processed
    const sourceKeys = tilesetSource.getKeys();
    for (const sourceKey of sourceKeys) {
      if (sourceKey !== tilesetSourceJsonFileName) {
        await this.processEntry(
          sourceKey,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          async (sourceEntry: TilesetEntry, type: string | undefined) => {
            return sourceEntry;
          }
        );
      }
    }

    const entries = TilesetSources.getEntries(tilesetSource);
    for (const entry of entries) {
      const key = entry.key;
      // The tileset JSON file will be added explicitly below
      if (!this.isProcessed(key) && key !== tilesetSourceJsonFileName) {
        this.markAsProcessed(key);
        this.storeTargetEntries(entry);
      }
    }

    const tilesetTargetJsonFileName = context.tilesetTargetJsonFileName;
    const tileset = context.tileset;
    const tilesetJsonWasZipped = context.tilesetJsonWasZipped;

    // Store the resulting tileset as JSON
    TilesetProcessor.storeTargetValue(
      tilesetTarget,
      tilesetTargetJsonFileName,
      tilesetJsonWasZipped,
      tileset
    );

    // Clean up by closing the source and the target
    delete this.context;
    try {
      tilesetSource.close();
    } catch (error) {
      try {
        await tilesetTarget.end();
      } catch (e) {
        // Error already about to be re-thrown
      }
      throw error;
    }
    await tilesetTarget.end();
  }

  /**
   * Process the specified entry.
   *
   * If the entry with the specified key was already processed,
   * then this method does nothing.
   *
   * Otherwise, the specified entry will be looked up in the tileset
   * source, and passed to the given entry processor, together with
   * its type information.
   *
   * The resulting target entry (if any) will be stored in the
   * tileset target, and both the source and the target will
   * be marked as 'processed'
   *
   * @param sourceKey - The key (file name) of the entry
   * @param entryProcessor - The `TilesetEntryProcessor` that will
   * be called to process the actual entry.
   * @returns A promise that resolves when the process is finished
   * @throws DeveloperError When the source or target is not opened
   * @throws TilesetError When the input could not be processed
   */
  protected async processEntry(
    sourceKey: string,
    entryProcessor: TilesetEntryProcessor
  ): Promise<void> {
    if (this.isProcessed(sourceKey)) {
      return;
    }
    const sourceEntry = await this.fetchSourceEntry(sourceKey);
    if (!sourceEntry) {
      this.markAsProcessed(sourceKey);
      const message = `No ${sourceKey} found in input`;
      //throw new TilesetError(message);
      console.warn(message);
      return;
    }
    const targetEntry = await this.processEntryInternal(
      sourceEntry,
      entryProcessor
    );

    this.markAsProcessed(sourceEntry.key);
    if (targetEntry) {
      this.putTargetKey(sourceEntry.key, targetEntry.key);
      this.markAsProcessed(targetEntry.key);
      this.storeTargetEntries(targetEntry);
    }
  }

  /**
   * Process the given source entry, and return the processed result.
   *
   * This will determine the content type of the given entry, and pass
   * it together with its type information to the `entryProcessor`.
   *
   * This will *not* store the returned target entry in the tileset
   * target. To do so, `storeTargetEntries` has to be called with
   * the result.
   *
   * @param sourceEntry - The source entry
   * @param entryProcessor The `TilesetEntryProcessor`
   * @returns The target entry
   */
  private async processEntryInternal(
    sourceEntry: TilesetEntry,
    entryProcessor: TilesetEntryProcessor
  ): Promise<TilesetEntry | undefined> {
    const type = await ContentDataTypeRegistry.findType(
      sourceEntry.key,
      sourceEntry.value
    );

    this.log(`Processing source: ${sourceEntry.key} with type ${type}`);

    const targetEntry = await entryProcessor(sourceEntry, type);

    this.log(`        to target: ${targetEntry?.key}`);

    return targetEntry;
  }

  /**
   * Fetch the entry for the specified key from the current tileset
   * source. If there is no entry for the given key, then `undefined`
   * is returned.
   *
   * @param key - The key (file name)
   * @returns The object containing the entry and its type
   */
  private async fetchSourceEntry(
    key: string
  ): Promise<TilesetEntry | undefined> {
    const context = this.getContext();
    const tilesetSource = context.tilesetSource;

    const sourceKey = key;
    const sourceValue = tilesetSource.getValue(sourceKey);
    if (!sourceValue) {
      console.warn("No input found for " + sourceKey);
      return undefined;
    }
    const sourceEntry: TilesetEntry = {
      key: sourceKey,
      value: sourceValue,
    };
    return sourceEntry;
  }

  /**
   * Store the given entries in the current target
   *
   * @param targetEntries - The target entries
   */
  storeTargetEntries(...targetEntries: TilesetEntry[]) {
    const context = this.getContext();
    const tilesetTarget = context.tilesetTarget;
    for (const targetEntry of targetEntries) {
      tilesetTarget.addEntry(targetEntry.key, targetEntry.value);
    }
  }

  /**
   * Mark a certain entry (file) as already having been processed,
   * and no longer be considered in subsequent steps.
   *
   * @param key - The key (file name)
   */
  markAsProcessed(key: string) {
    const context = this.getContext();
    context.processedKeys[key] = true;
  }

  /**
   * Returns whether the entry with the given key (file name) was
   * already processed.
   *
   * @param key - The key (file name)
   * @returns Whether the entry was already processed
   */
  isProcessed(key: string): boolean {
    const context = this.getContext();
    return context.processedKeys[key] === true;
  }

  /**
   * Stores the new key (file name) that the the entry with the
   * given key received during processing.
   *
   * @param sourceKey - The key (file name)
   * @returns The target key, or `undefined`
   */
  protected putTargetKey(sourceKey: string, targetKey: string) {
    const context = this.getContext();
    context.targetKeys[sourceKey] = targetKey;
  }

  /**
   * Returns the new key (file name) that the the entry with the
   * given key received during processing.
   *
   * When this is `undefined`, then this may either mean that
   * the entry was removed during processing, or that it has
   * not been procesed yet. The latter can be checked with
   * `isProcessed`.
   *
   * @param sourceKey - The key (file name)
   * @returns The target key, or `undefined`
   */
  protected getTargetKey(sourceKey: string): string | undefined {
    const context = this.getContext();
    return context.targetKeys[sourceKey];
  }

  /**
   * Parses the JSON from the value with the given key (file name),
   * and returns the parsed result, AND information of whether the
   * input was zipped.
   *
   * This is mainly a convenience function to emulate the behavior of the
   * "legacy" tools in terms of handling the tileset JSON: When writing
   * the tileset JSON data to the target, then it should zip that JSON
   * data if and only if it was zipped in the input.
   *
   * See `storeTargetValue` for the counterpart of this method.
   *
   * In the future, there might be mechanisms for a more fine-grained
   * control over whether certain files should be zipped or not...
   *
   * @param tilesetSource - The `TilesetSource`
   * @param key - The key (file name)
   * @returns A structure containing the `wasZipped` information, and
   * the parsed result
   * @throws TilesetError If the source is not opened, the specified
   * entry cannot be found, or the entry data could not be unzipped,
   * or its contents could not be parsed as JSON.
   */
  private static parseSourceValue<T>(
    tilesetSource: TilesetSource,
    key: string
  ): { wasZipped: boolean; result: T } {
    let value = TilesetProcessor.getSourceValue(tilesetSource, key);
    let wasZipped = false;
    if (Buffers.isGzipped(value)) {
      wasZipped = true;
      try {
        value = Buffers.gunzip(value);
      } catch (e) {
        const message = `Could not unzip ${key}: ${e}`;
        throw new TilesetError(message);
      }
    }
    try {
      const result = JSON.parse(value.toString()) as T;
      return {
        wasZipped: wasZipped,
        result: result,
      };
    } catch (e) {
      const message = `Could not parse ${key}: ${e}`;
      throw new TilesetError(message);
    }
  }

  /**
   * Convert the given object into a JSON string, put it into a buffer,
   * zip it (based on the `doZip` flag), and put the result into the
   * tileset target.
   *
   * This is only intended for the "legacy" handling of the tileset
   * JSON data, and is the counterpart of `parseSourceValue`. See
   * `parseSourceValue` for details.
   *
   * @param tilesetTarget - The `TilesetTarget`
   * @param key - The key (file name)
   * @param doZip - Whether the output should be zipped
   * @param object - The object for which the JSON should be stored
   * @throws DeveloperError When the target is not opened
   */
  private static storeTargetValue(
    tilesetTarget: TilesetTarget,
    key: string,
    doZip: boolean,
    object: object
  ) {
    const jsonString = JSON.stringify(object, null, 2);
    let jsonBuffer = Buffer.from(jsonString);
    if (doZip) {
      jsonBuffer = Buffers.gzip(jsonBuffer);
    }
    tilesetTarget.addEntry(key, jsonBuffer);
  }

  /**
   * Obtains the value for the given key from the current tileset source,
   * throwing an error if the source is not opened, or when the
   * given key cannot be found.
   *
   * @param tilesetSource - The `TilesetSource`
   * @param key - The key (file name)
   * @returns The value (file contents)
   * @throws DeveloperError When the source is not opened
   * @throws TilesetError When the given key cannot be found
   */
  private static getSourceValue(
    tilesetSource: TilesetSource,
    key: string
  ): Buffer {
    const buffer = tilesetSource.getValue(key);
    if (!buffer) {
      const message = `No ${key} found in input`;
      throw new TilesetError(message);
    }
    return buffer;
  }

  /**
   * Resolve the `Schema` for the given tileset.
   *
   * This is either the `tileset.schema`, or the schema that is
   * obtained from the `tileset.schemaUri`, or `undefined` if
   * neither of them are present.
   *
   * @param tilesetSource - The `TilesetSource`
   * @param tileset - The tileset
   * @returns The `Schema`, or `undefined` if there is none
   * @throws DeveloperError If the source is not opened
   * @throws TilesetError If the schema from the `schemaUri`
   * could not be resolved or parsed.
   */
  private static resolveSchema(
    tilesetSource: TilesetSource,
    tileset: Tileset
  ): Schema | undefined {
    if (tileset.schema) {
      return tileset.schema;
    }
    if (tileset.schemaUri) {
      const parsedSchema = TilesetProcessor.parseSourceValue<Schema>(
        tilesetSource,
        tileset.schemaUri
      );
      return parsedSchema.result;
    }
    return undefined;
  }
}