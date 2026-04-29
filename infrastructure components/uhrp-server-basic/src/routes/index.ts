import put from './put';
import quote from './quote';
import upload from './upload';
import list from './list';
import renew from './renew';
import find from './find';

const routes = {
  preAuth: [
    put,
    quote
  ],
  postAuth: [
    upload,
    list,
    renew,
    find
  ]
};

export default routes;
