declare module "port-get" {
  export default function (portlist?: number[], host?: string): Promise<number>;
}
