import Dexie from 'dexie';
import { extractDbSchema } from './helpers';
import { DexieExportJsonStructure, VERSION } from './json-structure';
import { TSON } from './tson';
import { JsonStream } from './json-stream';

export interface StaticImportOptions {
  noTransaction?: boolean;
  numKilobytesPerChunk?: number; // Default: 1024 ( 1MB )
  filter?: (table: string, value: any, key?: any) => boolean;
  progressCallback?: (progress: ImportProgress) => boolean;
}

export interface ImportOptions extends StaticImportOptions {
  acceptMissingTables?: boolean;
  acceptVersionDiff?: boolean;
  acceptNameDiff?: boolean;
  acceptChangedPrimaryKey?: boolean;
  overwriteValues?: boolean;
  clearTablesBeforeImport?: boolean;
  noTransaction?: boolean;
  numKilobytesPerChunk?: number; // Default: 1024 ( 1MB )
  filter?: (table: string, value: any, key?: any) => boolean;
  progressCallback?: (progress: ImportProgress) => boolean;
}

export interface ImportProgress {
  totalTables: number;
  completedTables: number;
  totalRows: number | undefined;
  completedRows: number;
  done: boolean;
}

export async function importDB(exportedData: Blob | JsonStream<DexieExportJsonStructure>, options?: StaticImportOptions): Promise<Dexie> {
  options = options || {}; // All booleans defaults to false.
  const CHUNK_SIZE = (options!.numKilobytesPerChunk || 512) * 1024;
  const stream = await loadUntilWeGotEnoughData(exportedData, CHUNK_SIZE);
  const dbExport = stream.result.data!;
  const db = new Dexie(dbExport.databaseName);
  db.version(dbExport.databaseVersion).stores(extractDbSchema(dbExport));
  await importInto(db, stream, options);
  return db;
}

export async function importInto(db: Dexie, exportedData: Blob | JsonStream<DexieExportJsonStructure>, options?: ImportOptions): Promise<void> {
  options = options || {}; // All booleans defaults to false.
  const CHUNK_SIZE = (options!.numKilobytesPerChunk || 512) * 1024;
  const jsonStream = await loadUntilWeGotEnoughData(exportedData, CHUNK_SIZE);
  let dbExportFile = jsonStream.result;

  const dbExport = dbExportFile.data!;

  if (!options!.acceptNameDiff && db.name !== dbExport.databaseName)
    throw new Error(`Name differs. Current database name is ${db.name} but export is ${dbExport.databaseName}`);
  if (!options!.acceptVersionDiff && db.verno !== dbExport.databaseVersion) {
    // Possible feature: Call upgraders in some isolated way if this happens... ?
    throw new Error(`Database version differs. Current database is in version ${db.verno} but export is ${dbExport.databaseVersion}`);
  }
  
  const { progressCallback } = options;
  const progress: ImportProgress = {
    done: false,
    completedRows: 0,
    completedTables: 0,
    totalRows: dbExport.tables.reduce((p, c) => p + c.rowCount, 0),
    totalTables: dbExport.tables.length
  };
  if (progressCallback) {
    if (progressCallback(progress))
      throw new Error("Operation aborted");
  }

  if (options.noTransaction) {
    await importAll();
  } else {
    await db.transaction('rw', db.tables, importAll);
  }  

  async function importAll () {
    do {
      for (const tableExport of dbExport.data) {
        if (!tableExport.rows) break; // Need to pull more!
        if ((tableExport.rows as any).complete && tableExport.rows.length === 0)
          continue;

        if (progressCallback) {
          if (progressCallback(progress))
            throw new Error("Operation aborted");
        }
        const tableName = tableExport.tableName;
        const table = db.table(tableName);
        const tableSchemaStr = dbExport.tables.filter(t => t.name === tableName)[0].schema;
        if (!table) {
          if (!options!.acceptMissingTables)
            throw new Error(`Exported table ${tableExport.tableName} is missing in installed database`);
          else
            continue;
        }
        if (!options!.acceptChangedPrimaryKey &&
          tableSchemaStr.split(',')[0] != table.schema.primKey.src) {
          throw new Error(`Primary key differs for table ${tableExport.tableName}. `);
        }
        const rows = tableExport.rows.map(row => TSON.revive(row));
        const filter = options!.filter;
        const filteredRows = filter ?
          tableExport.inbound ?
            rows.filter(value => filter(tableName, value)) :
            rows.filter(([key, value]) => filter(tableName, value, key)) :
          rows;
        const [keys, values] = tableExport.inbound ?
          [undefined, filteredRows] :
          [filteredRows.map(row=>row[0]), rows.map(row=>row[1])];

        if (options!.clearTablesBeforeImport) {
          await table.clear();
        }
        if (options!.overwriteValues)
          await table.bulkPut(values, keys);
        else
          await table.bulkAdd(values, keys);
          
        progress.completedRows += rows.length;
        if ((rows as any).complete) {
          progress.completedTables += 1;
        }
        rows.splice(0, rows.length); // Free up RAM, keep existing array instance.
      }

      // Avoid unnescessary loops in "for (const tableExport of dbExport.data)" 
      while (dbExport.data.length > 0 && (dbExport.data[0].rows as any).complete) {
        // We've already imported all rows from the first table. Delete its occurrence
        dbExport.data.splice(0, 1); 
      }
      if (!jsonStream.done() && !jsonStream.eof()) {
        // Pull some more (keeping transaction alive)
        await Dexie.waitFor(jsonStream.pull(CHUNK_SIZE));
      }
    } while (!jsonStream.done() && !jsonStream.eof());
  }
  progress.done = true;
  if (progressCallback) {
    if (progressCallback(progress))
      throw new Error("Operation aborted");
  }
}

async function loadUntilWeGotEnoughData(exportedData: Blob | JsonStream<DexieExportJsonStructure>, CHUNK_SIZE: number): Promise<JsonStream<DexieExportJsonStructure>> {
  const stream = ('slice' in exportedData ?
    JsonStream<DexieExportJsonStructure>(exportedData) :
    exportedData);

  while (!stream.eof() && (!stream.result.data || !stream.result.data.data)) {
    await stream.pull(CHUNK_SIZE);
  }
  const dbExportFile = stream.result;
  if (!dbExportFile || dbExportFile.formatName != "dexie")
    throw new Error(`Given file is not a dexie export`);
  if (dbExportFile.formatVersion! > VERSION) {
    throw new Error(`Format version ${dbExportFile.formatVersion} not supported`);
  }
  if (!dbExportFile.data!) {
    throw new Error(`No data in export file`);
  }
  if (!dbExportFile.data!.databaseName) {
    throw new Error(`Missing databaseName in export file`);
  }
  if (!dbExportFile.data!.databaseVersion) {
    throw new Error(`Missing databaseVersion in export file`);
  }
  if (!dbExportFile.data!.tables) {
    throw new Error(`Missing tables in export file`);
  }
  return stream;  
}