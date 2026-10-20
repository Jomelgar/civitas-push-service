import { config } from '../config';
import { db } from '../db/client';
import { QueueStore } from './store';

export const queue = new QueueStore(db, config.queueCapacity, config.pushJobTtlSeconds * 1000);
