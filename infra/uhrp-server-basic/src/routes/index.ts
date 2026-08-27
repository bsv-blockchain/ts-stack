import put from './put';
import quote from './quote';
import upload from './upload';
import list from './list';
import renew from './renew';
import find from './find';
import { chirpPostAuthRoutes, chirpPreAuthRoutes } from '../chirp/routes';

const routes = {
  preAuth: [
    put,
    quote,
    ...chirpPreAuthRoutes
  ],
  postAuth: [
    upload,
    list,
    renew,
    find,
    ...chirpPostAuthRoutes
  ]
};

export default routes;
