declare module 'bun-storage' {
  export function createLocalStorage(path?: string): [
    {
      get: (key: string) => Promise<any> | any,
      set: (key: string, value: any) => Promise<void> | void,
      delete?: (key: string) => Promise<void> | void,
    },
    any
  ];
}

