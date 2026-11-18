import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Bonjour, type Service } from 'bonjour-service';
import { SERVICE_TYPE, type Advertisement } from './protocol';

/** Another Muse with sync on, as found on the network. */
export interface FoundPeer {
  deviceId: string;
  name: string;
  tag: string;
  host: string;
  port: number;
}

/**
 * Finding other Muse apps on the network. The engine only needs this much, so tests can stand in
 * a simple in-process version for Bonjour.
 *
 * Events: `up` (FoundPeer), `down` (deviceId).
 */
export interface Discovery extends EventEmitter {
  advertise(port: number, ad: Advertisement): void;
  stop(): void;
}

/** Prefers an IPv4 address: it needs no interface scope in a URL. */
function pickHost(service: Service): string | null {
  const addresses = service.addresses ?? [];
  const v4 = addresses.find((a) => net.isIPv4(a) && !a.startsWith('169.254.'));
  if (v4) return v4;
  if (service.referer?.address && net.isIPv4(service.referer.address)) return service.referer.address;
  return addresses.find((a) => net.isIPv4(a)) ?? null;
}

/** Bonjour (`_muse-sync._tcp`), through the bonjour-service package. */
export class BonjourDiscovery extends EventEmitter implements Discovery {
  private bonjour: Bonjour | null = null;
  private published: Service | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;
  private ownId = '';
  private byFqdn = new Map<string, string>();

  advertise(port: number, ad: Advertisement): void {
    this.ownId = ad.id;
    if (!this.bonjour) {
      this.bonjour = new Bonjour({}, (err: Error) => console.warn('[sync] bonjour error:', err.message));
      this.browse(this.bonjour);
    }
    const bonjour = this.bonjour;
    const publish = () => {
      // The instance name only has to be unique on the network; the TXT record carries the
      // name people see.
      this.published = bonjour.publish({
        name: `Muse ${ad.id.slice(0, 8)}`,
        type: SERVICE_TYPE,
        port,
        txt: { ...ad },
        disableIPv6: false,
      });
      this.published.on('error', (err: Error) => console.warn('[sync] advertising failed:', err.message));
    };
    if (this.published) {
      const old = this.published;
      this.published = null;
      old.stop?.(publish);
    } else {
      publish();
    }
  }

  private browse(bonjour: Bonjour): void {
    this.browser = bonjour.find({ type: SERVICE_TYPE });
    this.browser.on('up', (service: Service) => this.found(service));
    // Re-announcing (a new name, a new group) arrives as an update to the same service.
    this.browser.on('txt-update', (service: Service) => this.found(service));
    this.browser.on('srv-update', (service: Service) => this.found(service));
    this.browser.on('down', (service: Service) => {
      const id = this.byFqdn.get(service.fqdn);
      if (id) {
        this.byFqdn.delete(service.fqdn);
        this.emit('down', id);
      }
    });
  }

  private found(service: Service): void {
    const txt = (service.txt ?? {}) as Partial<Advertisement>;
    if (!txt.id || txt.id === this.ownId || txt.v !== '1') return;
    const host = pickHost(service);
    if (!host) return;
    this.byFqdn.set(service.fqdn, txt.id);
    this.emit('up', { deviceId: txt.id, name: txt.name || 'Mac', tag: txt.tag ?? '', host, port: service.port } satisfies FoundPeer);
  }

  /** Asks the network again; Bonjour answers lazily otherwise. */
  refresh(): void {
    this.browser?.update();
  }

  stop(): void {
    const bonjour = this.bonjour;
    this.bonjour = null;
    this.browser?.stop();
    this.browser = null;
    this.byFqdn.clear();
    if (!bonjour) return;
    bonjour.unpublishAll(() => bonjour.destroy());
    this.published = null;
  }
}
