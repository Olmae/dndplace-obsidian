export type Capability='archive.read'|'archive.write'|'archive.history';
export type ConnectionDTO={protocolVersion:1;instanceId:string;account:{id:string;name:string};capabilities:Capability[];limits:Record<string,number>;readiness:{read:boolean;write:boolean;missing:string[]}};
export type SyncIdentity={connectionId:string;instanceId:string;accountId:string;campaignId:string;bindingId:string};
