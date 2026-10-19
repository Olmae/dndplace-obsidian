declare module 'yazl' {
  import type {Readable} from 'node:stream';
  export class ZipFile {
    outputStream:Readable;
    addBuffer(data:Buffer,path:string,options?:{compress?:boolean;mtime?:Date;mode?:number;forceDosTimestamp?:boolean}):void;
    end():void;
  }
}
