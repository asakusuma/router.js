import { Dict } from '../core';
import HandlerInfo, {
  Route,
  UnresolvedHandlerInfoByObject,
  UnresolvedHandlerInfoByParam,
} from '../route-info';
import Router, { SerializerFunc } from '../router';
import { TransitionIntent } from '../transition-intent';
import TransitionState from '../transition-state';
import { extractQueryParams, isParam, merge } from '../utils';

export default class NamedTransitionIntent extends TransitionIntent {
  name: string;
  pivotHandler?: Route;
  contexts: Dict<unknown>[];
  queryParams: Dict<unknown>;
  preTransitionState?: TransitionState = undefined;

  constructor(
    name: string,
    router: Router,
    pivotHandler: Route | undefined,
    contexts: Dict<unknown>[] = [],
    queryParams: Dict<unknown> = {}
  ) {
    super(router);
    this.name = name;
    this.pivotHandler = pivotHandler;
    this.contexts = contexts;
    this.queryParams = queryParams;
  }

  applyToState(oldState: TransitionState, isIntermediate: boolean) {
    // TODO: WTF fix me
    let partitionedArgs = extractQueryParams([this.name].concat(this.contexts as any)),
      pureArgs = partitionedArgs[0],
      handlers = this.router.recognizer.handlersFor(pureArgs[0]);

    let targetRouteName = handlers[handlers.length - 1].handler;

    return this.applyToHandlers(oldState, handlers, targetRouteName, isIntermediate, false);
  }

  applyToHandlers(
    oldState: TransitionState,
    handlers: Route[],
    targetRouteName: string,
    isIntermediate: boolean,
    checkingIfActive: boolean
  ) {
    let i, len;
    let newState = new TransitionState();
    let objects = this.contexts.slice(0);

    let invalidateIndex = handlers.length;

    // Pivot handlers are provided for refresh transitions
    if (this.pivotHandler) {
      for (i = 0, len = handlers.length; i < len; ++i) {
        if (handlers[i].handler === this.pivotHandler.routeName) {
          invalidateIndex = i;
          break;
        }
      }
    }

    for (i = handlers.length - 1; i >= 0; --i) {
      let result = handlers[i];
      let name = result.handler;

      let oldHandlerInfo = oldState.handlerInfos[i];
      let newHandlerInfo = null;

      if (result.names.length > 0) {
        if (i >= invalidateIndex) {
          newHandlerInfo = this.createParamHandlerInfo(name, result.names, objects, oldHandlerInfo);
        } else {
          newHandlerInfo = this.getHandlerInfoForDynamicSegment(
            name,
            result.names,
            objects,
            oldHandlerInfo,
            targetRouteName,
            i
          );
        }
      } else {
        // This route has no dynamic segment.
        // Therefore treat as a param-based handlerInfo
        // with empty params. This will cause the `model`
        // hook to be called with empty params, which is desirable.
        newHandlerInfo = this.createParamHandlerInfo(name, result.names, objects, oldHandlerInfo);
      }

      if (checkingIfActive) {
        // If we're performing an isActive check, we want to
        // serialize URL params with the provided context, but
        // ignore mismatches between old and new context.
        newHandlerInfo = newHandlerInfo.becomeResolved(null, newHandlerInfo.context!);
        let oldContext = oldHandlerInfo && oldHandlerInfo.context;
        if (
          result.names.length > 0 &&
          oldHandlerInfo.context !== undefined &&
          newHandlerInfo.context === oldContext
        ) {
          // If contexts match in isActive test, assume params also match.
          // This allows for flexibility in not requiring that every last
          // handler provide a `serialize` method
          newHandlerInfo.params = oldHandlerInfo && oldHandlerInfo.params;
        }
        newHandlerInfo.context = oldContext;
      }

      let handlerToUse = oldHandlerInfo;
      if (i >= invalidateIndex || newHandlerInfo.shouldSupercede(oldHandlerInfo)) {
        invalidateIndex = Math.min(i, invalidateIndex);
        handlerToUse = newHandlerInfo;
      }

      if (isIntermediate && !checkingIfActive) {
        handlerToUse = handlerToUse.becomeResolved(null, handlerToUse.context!);
      }

      newState.handlerInfos.unshift(handlerToUse);
    }

    if (objects.length > 0) {
      throw new Error(
        'More context objects were passed than there are dynamic segments for the route: ' +
          targetRouteName
      );
    }

    if (!isIntermediate) {
      this.invalidateChildren(newState.handlerInfos, invalidateIndex);
    }

    merge(newState.queryParams, this.queryParams || {});

    return newState;
  }

  invalidateChildren(handlerInfos: HandlerInfo[], invalidateIndex: number) {
    for (let i = invalidateIndex, l = handlerInfos.length; i < l; ++i) {
      let handlerInfo = handlerInfos[i];
      if (handlerInfo.isResolved) {
        let { name, params, route } = handlerInfos[i];
        handlerInfos[i] = new UnresolvedHandlerInfoByParam(name, this.router, params, route);
      }
    }
  }

  getHandlerInfoForDynamicSegment(
    name: string,
    names: string[],
    objects: Dict<unknown>[],
    oldHandlerInfo: HandlerInfo,
    _targetRouteName: string,
    i: number
  ) {
    let objectToUse: Dict<unknown>;
    if (objects.length > 0) {
      // Use the objects provided for this transition.
      objectToUse = objects[objects.length - 1];
      if (isParam(objectToUse)) {
        return this.createParamHandlerInfo(name, names, objects, oldHandlerInfo);
      } else {
        objects.pop();
      }
    } else if (oldHandlerInfo && oldHandlerInfo.name === name) {
      // Reuse the matching oldHandlerInfo
      return oldHandlerInfo;
    } else {
      if (this.preTransitionState) {
        let preTransitionHandlerInfo = this.preTransitionState.handlerInfos[i];
        objectToUse = preTransitionHandlerInfo && preTransitionHandlerInfo.context!;
      } else {
        // Ideally we should throw this error to provide maximal
        // information to the user that not enough context objects
        // were provided, but this proves too cumbersome in Ember
        // in cases where inner template helpers are evaluated
        // before parent helpers un-render, in which cases this
        // error somewhat prematurely fires.
        //throw new Error("Not enough context objects were provided to complete a transition to " + targetRouteName + ". Specifically, the " + name + " route needs an object that can be serialized into its dynamic URL segments [" + names.join(', ') + "]");
        return oldHandlerInfo;
      }
    }

    return new UnresolvedHandlerInfoByObject(name, names, this.router, objectToUse);
  }

  createParamHandlerInfo(
    name: string,
    names: string[],
    objects: Dict<unknown>[],
    oldHandlerInfo: HandlerInfo
  ) {
    let params: Dict<unknown> = {};

    // Soak up all the provided string/numbers
    let numNames = names.length;
    while (numNames--) {
      // Only use old params if the names match with the new handler
      let oldParams =
        (oldHandlerInfo && name === oldHandlerInfo.name && oldHandlerInfo.params) || {};

      let peek = objects[objects.length - 1];
      let paramName = names[numNames];
      if (isParam(peek)) {
        params[paramName] = '' + objects.pop();
      } else {
        // If we're here, this means only some of the params
        // were string/number params, so try and use a param
        // value from a previous handler.
        if (oldParams.hasOwnProperty(paramName)) {
          params[paramName] = oldParams[paramName];
        } else {
          throw new Error(
            "You didn't provide enough string/numeric parameters to satisfy all of the dynamic segments for route " +
              name
          );
        }
      }
    }

    return new UnresolvedHandlerInfoByParam(name, this.router, params);
  }
}
